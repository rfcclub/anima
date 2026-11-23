import { execFile } from "node:child_process";
import { isIP } from "node:net";
import type { LaunchdProbe, PortProbe } from "./checks.ts";

export interface CommandResult { code: number | null; stdout: string; stderr: string }
export interface CommandOptions { timeoutMs: number; maxOutputBytes: number; shell: false; signal: AbortSignal }
export type CommandRunner = (program: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;
export type PortObservation = { kind: "complete"; probe: PortProbe } | { kind: "unknown"; port: number; reason: string };

const MAX_OUTPUT_BYTES = 65_536;

/** Executor for the later runner: fixed argument arrays, no shell, bounded time and output. */
export const runSystemCommand: CommandRunner = (program, args, options) => new Promise((resolve) => {
  execFile(program, [...args], {
    shell: false, timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes,
    signal: options.signal, encoding: "utf8", windowsHide: true,
  }, (error, stdout, stderr) => {
    const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
    resolve({ code, stdout, stderr });
  });
});

function validate(owned: string[], ports: Record<string, string>, uid: number, timeoutMs: number): void {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("invalid probe limits");
  if (!Array.isArray(owned) || new Set(owned).size !== owned.length || owned.some((label) =>
    typeof label !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(label) || /^\d+$/.test(label))) throw new Error("invalid launchd labels");
  if (owned.length + Object.keys(ports).length > 128) throw new Error("too many probes");
  for (const [port, label] of Object.entries(ports)) {
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65_535 || String(value) !== port || !owned.includes(label)) throw new Error("invalid port configuration");
  }
}

async function bounded(run: CommandRunner, program: string, args: string[], timeoutMs: number): Promise<CommandResult | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); });
    const result = await Promise.race([
      Promise.resolve().then(() => run(program, args, { timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES, shell: false, signal: controller.signal })).catch(() => null),
      timeout,
    ]);
    if (!result || typeof result.stdout !== "string" || typeof result.stderr !== "string" ||
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES) return null;
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Keep only root-level job fields so nested launchd details cannot affect the checks. */
function jobPid(output: string, target: string): { valid: boolean; pid?: number; output?: string } {
  const lines = output.split("\n");
  if (lines.pop() !== "" || lines.shift()?.trim() !== `${target} = {`) return { valid: false };
  let depth = 1, pid: number | undefined, sawState = false, closed = false;
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const text = line.trim();
    if (closed) { if (text) return { valid: false }; continue; }
    if (text === "}") { if (--depth === 0) closed = true; continue; }
    if (/=\s*\{$/.test(text)) { depth++; continue; }
    if (depth !== 1) continue;
    const key = /^(pid|state|runs|last exit code|last terminating signal)\s*=/.exec(text)?.[1];
    if (key) {
      if (seen.has(key)) return { valid: false };
      seen.add(key);
      fields.push(text);
    }
    if (depth === 1 && /^state\s*=/.test(text)) {
      if (sawState || !/^state\s*=\s*\S.+$/.test(text)) return { valid: false };
      sawState = true;
    }
    if (depth === 1 && /^pid\s*=/.test(text)) {
      const match = /^pid\s*=\s*(\d+)$/.exec(text);
      if (!match || pid !== undefined || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) return { valid: false };
      pid = Number(match[1]);
    }
  }
  return { valid: closed && depth === 0 && (sawState || pid !== undefined), pid, output: `${fields.join("\n")}\n` };
}

/** Parse lsof's process/file field format, requiring complete TCP LISTEN records. */
function listenerPids(output: string, port: number): number[] | null {
  const lines = output.split("\n");
  if (lines.pop() !== "") return null;
  const found: number[] = [];
  let pid: number | undefined, file: { protocol?: string; name?: string; state?: string } | undefined;
  let processHasFile = false;
  const finish = (): boolean => {
    if (!file) return true;
    const host = file.name?.endsWith(`:${port}`) ? file.name.slice(0, -String(port).length - 1) : "";
    const address = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    const valid = pid !== undefined && file.protocol === "TCP" && file.state === "LISTEN" &&
      (host === "*" || isIP(address) !== 0);
    if (valid) found.push(pid!);
    file = undefined;
    return valid;
  };
  for (const line of lines) {
    if (!line) return null;
    const key = line[0], value = line.slice(1);
    if (key === "p") {
      if (!finish() || (pid !== undefined && !processHasFile) || !/^\d+$/.test(value)) return null;
      pid = Number(value); processHasFile = false;
      if (!Number.isSafeInteger(pid) || pid < 1) return null;
    } else if (key === "c") {
      if (pid === undefined || file || !value) return null;
    } else if (key === "f") {
      if (pid === undefined || !value || !finish()) return null;
      file = {}; processHasFile = true;
    } else if (key === "P" || key === "n") {
      if (!file || !value) return null;
      const field = key === "P" ? "protocol" : "name";
      if (file[field] !== undefined) return null;
      file[field] = value;
    } else if (key === "T") {
      if (!file || !value) return null;
      if (value.startsWith("ST=")) {
        if (file.state !== undefined) return null;
        file.state = value.slice(3);
      }
    } else return null;
  }
  return finish() && pid !== undefined && processHasFile && found.length ? found : null;
}

export async function collectLiveProbes(options: {
  owned: string[]; ports: Record<string, string>; uid: number; timeoutMs: number; run: CommandRunner;
}): Promise<{ launchd: LaunchdProbe[]; ports: PortObservation[] }> {
  const { owned, ports, uid, timeoutMs, run } = options;
  validate(owned, ports, uid, timeoutMs);
  const jobs = await Promise.all(owned.map(async (label) => {
    const target = `gui/${uid}/${label}`;
    const result = await bounded(run, "/bin/launchctl", ["print", target], timeoutMs);
    const parsed = result?.code === 0 && !result.stderr ? jobPid(result.stdout, target) : { valid: false };
    return { label, output: parsed.valid ? parsed.output! : null, pid: parsed.pid };
  }));
  const observations = await Promise.all(Object.entries(ports).map(async ([portText, owner]): Promise<PortObservation> => {
    const port = Number(portText);
    const unknown = (reason: string): PortObservation => ({ kind: "unknown", port, reason });
    const result = await bounded(run, "/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-FpcfPnT"], timeoutMs);
    if (!result || result.stderr || (result.code !== 0 && result.code !== 1)) return unknown("port probe unavailable");
    const ownerPid = jobs.find((job) => job.label === owner)?.pid;
    if (ownerPid === undefined || jobs.filter((job) => job.pid === ownerPid).length !== 1) return unknown("owner PID unknown");
    // lsof uses exit 1 with no output for a successful query with no matching files.
    if (result.code === 1 && !result.stdout) return { kind: "complete", probe: { port, listeners: [] } };
    if (result.code !== 0) return unknown("port probe unavailable");
    const pids = listenerPids(result.stdout, port);
    if (!pids) return unknown("incomplete port output");
    if (jobs.some((job) => job.pid === undefined)) return unknown("listener ownership unknown");
    const listeners: string[] = [];
    for (const pid of pids) {
      const matches = jobs.filter((job) => job.pid === pid);
      if (matches.length > 1) return unknown("listener ownership ambiguous");
      if (matches.length === 0) return unknown("listener ownership unknown");
      listeners.push(`${matches[0]!.label} ${pid}`);
    }
    return { kind: "complete", probe: { port, listeners } };
  }));
  return { launchd: jobs.map(({ label, output }) => ({ label, output })), ports: observations };
}
