/**
 * Escape suite for a model-written program (anima #427, codemode guest trust).
 *
 * A program tool runs code the model wrote. Wherever that code runs, it must not reach the filesystem, the
 * network, a process, the environment or the host's own globals other than through the tools it was granted.
 * This module defines the attempts once and can point them at a candidate runtime.
 *
 * Fail closed: an attempt that cannot be run is reported as not blocked, and a candidate is `proven` only when
 * every attempt was run and blocked. There is no "assume it would have been blocked".
 */

import { existsSync } from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProbeResult } from "../work/sandbox";

export type Candidate = "isolated-engine" | "hardened-worker" | "child-process";

export type EscapeCategory =
  | "file-read"
  | "file-write"
  | "network"
  | "process-spawn"
  | "environment"
  | "host-globals"
  | "timeout-ignores-cancellation";

/** One attempt, as a fragment of the guest program that reports `reached` when it got past the boundary. */
export interface EscapeAttempt {
  id: string;
  category: EscapeCategory;
  /** What a `reached` result would mean, in one line. */
  description: string;
  /** Guest code. Must call `report("<id>", true|false, detail)` exactly once and never throw out. */
  code: string;
}

/** Environment variables the guest is granted: everything else is an escape if it is visible. */
export const GUEST_ENV_ALLOW = ["PATH", "LANG", "LC_ALL", "TERM", "HOME", "TMPDIR"] as const;

const ALLOW = GUEST_ENV_ALLOW.map((name) => JSON.stringify(name)).join(", ");

/**
 * The attempts, in a fixed order. Each is independent: one attempt reaching the host does not stop the rest, so
 * a report names every hole rather than the first one.
 */
export const ESCAPE_ATTEMPTS: readonly EscapeAttempt[] = [
  {
    id: "file-read",
    category: "file-read",
    description: "read a host file outside any granted read tool",
    code: `try {
  const target = report.target || "/etc/hosts";
  const text = await Bun.file(target).text();
  report("file-read", text.length > 0, "read " + text.length + " characters");
} catch (error) { report("file-read", false, String(error && error.message ? error.message : error)); }`,
  },
  {
    id: "file-write",
    category: "file-write",
    description: "write a host file outside any granted write tool",
    code: `try {
  const target = report.writeTarget;
  await Bun.write(target, "escape-probe");
  report("file-write", true, "wrote " + target);
} catch (error) { report("file-write", false, String(error && error.message ? error.message : error)); }`,
  },
  {
    id: "network",
    category: "network",
    description: "open an outbound connection or resolve a host name",
    code: `let reached = false; let detail = "denied";
try {
  const response = await fetch(report.networkTarget, { signal: AbortSignal.timeout(1500) });
  reached = true; detail = "status " + response.status;
} catch (error) { detail = String(error && error.message ? error.message : error); }
report("network", reached, detail);`,
  },
  {
    id: "process-spawn",
    category: "process-spawn",
    description: "start a process and have it read a host file",
    code: `let reached = false; let detail = "denied";
try {
  const child = Bun.spawnSync(["/bin/sh", "-c", "cat " + (report.target || "/etc/hosts")]);
  reached = child.exitCode === 0 && child.stdout.length > 0;
  detail = "exit " + child.exitCode;
} catch (error) { detail = String(error && error.message ? error.message : error); }
report("process-spawn", reached, detail);`,
  },
  {
    id: "environment",
    category: "environment",
    description: "read an environment variable it was not granted",
    code: `const allowed = new Set(${JSON.stringify([...GUEST_ENV_ALLOW])});
const leaked = Object.keys(process.env).filter((key) => !allowed.has(key));
report("environment", leaked.length > 0, leaked.length > 0 ? "visible: " + leaked.join(",") : "only granted names");`,
  },
  {
    id: "host-globals",
    category: "host-globals",
    description: "reach the host runtime's own capabilities (spawn, module loader, raw process binding)",
    code: `const reachable = [];
try { if (typeof Bun !== "undefined" && typeof Bun.spawn === "function") reachable.push("Bun.spawn"); } catch {}
try { if (typeof process !== "undefined" && typeof process.dlopen === "function" && process.dlopen) reachable.push("process.dlopen"); } catch {}
try { if (typeof globalThis.require === "function") reachable.push("require"); } catch {}
try { if (typeof process !== "undefined" && typeof process.binding === "function") reachable.push("process.binding"); } catch {}
report("host-globals", reachable.length > 0, reachable.length > 0 ? "reachable: " + reachable.join(",") : "none visible");`,
  },
  {
    id: "timeout-ignores-cancellation",
    category: "timeout-ignores-cancellation",
    description: "keep running past its deadline and ignore cancellation, and leave a child running too",
    code: `let child = null;
try { child = Bun.spawn(["/bin/sh", "-c", "while true; do sleep 0.05; done"]); } catch {}
process.on("SIGTERM", () => {});
for (;;) { /* ignores cancellation on purpose */ }`,
  },
];

export interface EscapePaths {
  /** A host file the guest may not read. Must not be a real user's private path. */
  readTarget: string;
  /** A path outside every granted root the guest may not write. */
  writeTarget: string;
  /** An address the guest may not reach. Loopback is denied by the boundary. */
  networkTarget: string;
}

export interface EscapeRunOptions {
  /** Wall limit of the whole guest program. */
  deadlineMs?: number;
  /** Injected so the suite can be tested without the real write boundary. */
  probe?: () => ProbeResult;
  /** Injected so the suite can be tested without the real runtime. */
  spawnGuest?: (guest: string, paths: EscapePaths) => Promise<GuestOutcome>;
  paths?: Partial<EscapePaths>;
}

export interface GuestOutcome {
  /** True when the guest process (and anything it started) is proven gone. */
  stopped: boolean;
  /** What the guest printed. */
  output: string;
  /** True when the guest ran past its deadline before it was stopped. */
  timedOut: boolean;
  error?: string;
}

export interface EscapeResult {
  attempt: EscapeAttempt;
  /** True when the attempt was run and failed to reach anything, or was stopped at its deadline. */
  blocked: boolean;
  detail: string;
}

export interface EscapeReport {
  candidate: Candidate;
  /** True only when every attempt ran and was blocked. */
  proven: boolean;
  results: EscapeResult[];
  /** Why the report is not proven, when it is not. */
  reason?: string;
  /** Wall time to start and run the suite's guest, in milliseconds. */
  startupMs: number;
}

/** The guest program text: one attempt each, reporting on its own line, never throwing out of an attempt. */
export function guestProgram(attempts: readonly EscapeAttempt[] = ESCAPE_ATTEMPTS, paths?: Partial<EscapePaths>): string {
  const target = paths?.readTarget ?? "/etc/hosts";
  const writeTarget = paths?.writeTarget ?? "/etc/anima-escape-probe";
  const networkTarget = paths?.networkTarget ?? "http://127.0.0.1:9/";
  return [
    `const report = (id, reached, detail) => { console.log("RESULT " + id + " " + (reached ? "reached" : "blocked") + " " + String(detail ?? "")); };`,
    `report.target = ${JSON.stringify(target)};`,
    `report.writeTarget = ${JSON.stringify(writeTarget)};`,
    `report.networkTarget = ${JSON.stringify(networkTarget)};`,
    `const __attempt = async (code) => { try { await (new Function("report", "return (async () => {" + code + "})()"))(report); } catch (error) { console.log("THREW " + String(error && error.message ? error.message : error)); } };`,
    ...attempts.flatMap((attempt) => [`// attempt ${attempt.id} (${attempt.category})`, `await __attempt(${JSON.stringify(attempt.code)});`]),
  ].join("\n");
}

const ENGINE_UNAVAILABLE =
  "no maintained isolated JavaScript engine build is available in this runtime, so the attempts could not be run";

/**
 * Runs the suite against one candidate. None of these throw: a missing binary, an unavailable probe or a guest
 * that cannot be started all end up as "not blocked", with the reason.
 */
export async function runEscapeSuite(candidate: Candidate, options: EscapeRunOptions = {}): Promise<EscapeReport> {
  const started = Date.now();
  const paths: EscapePaths = {
    readTarget: options.paths?.readTarget ?? "/etc/hosts",
    writeTarget: options.paths?.writeTarget ?? "/etc/anima-escape-probe",
    networkTarget: options.paths?.networkTarget ?? "http://127.0.0.1:9/",
  };
  const unproven = (reason: string): EscapeReport => ({
    candidate,
    proven: false,
    results: ESCAPE_ATTEMPTS.map((attempt) => ({ attempt, blocked: false, detail: reason })),
    reason,
    startupMs: Date.now() - started,
  });

  // The isolated-engine candidate has no runtime here to point at, and the hardened worker shares Bun's own
  // globals by design. Both are reported unproven rather than assumed safe.
  if (candidate === "isolated-engine") return unproven(ENGINE_UNAVAILABLE);

  const probe = options.probe ?? (() => requireProbe());
  const probeResult = (() => {
    try {
      return probe();
    } catch (error) {
      return { ok: false as const, reason: `the boundary probe threw: ${error instanceof Error ? error.message : String(error)}` };
    }
  })();
  if (!probeResult.ok) {
    // `probeSandbox` prefixes its own reasons, so only add the prefix when it is missing.
    const reason = /^isolation unavailable\b/.test(probeResult.reason)
      ? probeResult.reason
      : `isolation unavailable: ${probeResult.reason}`;
    return unproven(reason);
  }

  const spawnGuest = options.spawnGuest ?? defaultSpawnGuest(options.deadlineMs ?? 5_000);
  const guest = guestProgram(ESCAPE_ATTEMPTS, paths);
  let outcome: GuestOutcome;
  try {
    outcome = await spawnGuest(guest, paths);
  } catch (error) {
    return unproven(`the guest could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }
  const startupMs = Date.now() - started;

  const seen = new Map<string, { reached: boolean; detail: string }>();
  for (const line of outcome.output.split("\n")) {
    const match = line.match(/^RESULT (\S+) (reached|blocked) ?(.*)$/);
    if (match) seen.set(match[1]!, { reached: match[2] === "reached", detail: match[3] ?? "" });
  }

  const results: EscapeResult[] = ESCAPE_ATTEMPTS.map((attempt) => {
    const line = seen.get(attempt.id);
    if (attempt.category === "timeout-ignores-cancellation") {
      // This attempt never reports success: it blocks only when the host stopped it at the deadline and its
      // child is gone too. A guest that printed nothing because it was killed is the expected shape.
      const blocked = outcome.stopped && outcome.timedOut;
      return {
        attempt,
        blocked,
        detail: blocked
          ? `stopped at the deadline and its child was stopped`
          : outcome.error ?? "the guest was not proven stopped at its deadline",
      };
    }
    if (!line) return { attempt, blocked: false, detail: outcome.error ?? "the attempt produced no result (fail closed)" };
    return { attempt, blocked: !line.reached, detail: line.detail || (line.reached ? "reached" : "blocked") };
  });

  const breached = results.filter((result) => !result.blocked);
  // Attempts that printed nothing are already not blocked; the reason says so, so a silent attempt is never
  // read as a pass. The deadline attempt never prints a result, so it is excluded from that list.
  const missing = breached.filter((result) => result.attempt.category !== "timeout-ignores-cancellation" && !seen.has(result.attempt.id));
  const reasons: string[] = [];
  if (breached.length > 0) reasons.push(`reached: ${breached.map((r) => r.attempt.id).join(", ")}`);
  if (missing.length > 0) reasons.push(`${missing.length} attempt(s) produced no result (fail closed)`);
  if (!outcome.stopped) reasons.push("the guest was not proven stopped");
  const proven = breached.length === 0 && outcome.stopped;
  return {
    candidate,
    proven,
    results,
    ...(proven ? {} : { reason: reasons.join("; ") }),
    startupMs,
  };
}

/** The real probe, imported lazily so a test can replace it. */
function requireProbe(): ProbeResult {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { probeSandbox } = require("../work/sandbox") as typeof import("../work/sandbox");
  return probeSandbox();
}

const defaultSpawnGuest = (deadlineMs: number) => async (guest: string): Promise<GuestOutcome> => {
  const { spawnSession } = await import("../work/supervisor");
  const { sandboxCommand, sanitizedEnv } = await import("../work/sandbox");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "codemode-escape-")));
  const root = join(base, "root");
  const tree = join(root, "tree");
  const tmp = join(root, "tmp");
  const home = join(root, "home");
  for (const dir of [tree, tmp, home]) mkdirSync(dir, { recursive: true });
  try {
    const handle = spawnSession({
      argv: sandboxCommand({ writableRoots: [root], denyReadRoots: [home, base] }, [process.execPath, "-e", guest]),
      cwd: tree,
      env: sanitizedEnv(process.env, { home, tmp }),
      root,
      deadlineMs,
      captureChars: 60_000,
    });
    const exit = await handle.exited;
    const out = await handle.output;
    const stop = await handle.stopAndProve({ graceMs: 500 });
    return { stopped: stop.proven, output: out.text, timedOut: exit.timedOut };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

/** True when the runtime a candidate would need is present here. Used only for reporting, never to skip a test. */
export function candidateAvailable(candidate: Candidate): boolean {
  if (candidate === "isolated-engine") return false;
  return existsSync(process.execPath);
}

if (import.meta.main) {
  const candidates: Candidate[] = ["isolated-engine", "hardened-worker", "child-process"];
  const chosen = process.argv.includes("--chosen") ? "child-process" : undefined;
  for (const candidate of candidates) {
    const report = await runEscapeSuite(candidate);
    const mark = report.proven ? "proven" : "NOT proven";
    console.log(`candidate ${candidate}: ${mark} (startup ${report.startupMs} ms)`);
    if (report.reason) console.log(`  reason: ${report.reason}`);
    for (const result of report.results) {
      console.log(`  ${result.blocked ? "blocked" : "REACHED"} ${result.attempt.id}: ${result.detail}`);
    }
  }
  if (chosen && !(await runEscapeSuite(chosen)).proven) process.exitCode = 1;
}
