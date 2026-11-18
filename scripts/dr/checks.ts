import type { CheckResult } from "./types.ts";

export interface LaunchdProbe {
  label: string;
  output: string | null;
}

export interface PortProbe {
  port: number;
  /**
   * Listener descriptions. When a process has multiple socket entries, include
   * its PID (as `pid 123`, `pid=123`, or the natural lsof command/PID columns)
   * so IPv4/IPv6 entries can be recognized as the same process.
   */
  listeners: string[];
}

export function checkLaunchd(probes: LaunchdProbe[]): CheckResult[] {
  return probes.map(({ label, output }) => {
    if (output === null) return { id: "launchd.loaded", subject: label, status: "unknown" };
    const running = /^\s*state\s*=\s*running\s*$/m.test(output);
    const hasPid = /^\s*pid\s*=\s*\d+\s*$/m.test(output);
    return running || hasPid
      ? { id: "launchd.loaded", subject: label, status: "pass" }
      : { id: "launchd.loaded", subject: label, status: "fail", reason: "not running" };
  });
}

export function checkCrashLoop(
  probes: LaunchdProbe[],
  now: number,
  thresholds: { crashRuns: number; crashWindowMinutes: number },
  samples: Record<string, { t: number; runs: number }[]>,
): { results: CheckResult[]; samples: Record<string, { t: number; runs: number }[]> } {
  const nextSamples = Object.fromEntries(Object.entries(samples).map(([label, values]) => [
    label,
    values.map((sample) => ({ ...sample })),
  ]));
  const windowStart = now - thresholds.crashWindowMinutes * 60_000;
  const results = probes.map(({ label, output }): CheckResult => {
    const result = (status: CheckResult["status"], reason?: string): CheckResult => ({
      id: "launchd.crashloop",
      subject: label,
      status,
      ...(reason === undefined ? {} : { reason }),
    });
    if (output === null) return result("unknown");

    const runsMatch = /^\s*runs\s*=\s*(\d+)\s*$/m.exec(output);
    if (!runsMatch) return result("unknown");
    const runs = Number(runsMatch[1]);
    if (!Number.isSafeInteger(runs)) return result("unknown");

    let prior = (nextSamples[label] ?? []).filter((sample) => sample.t >= windowStart);
    // A reset may have happened in an earlier probe still within the window.
    // Keep only the latest monotonically increasing run-counter segment.
    let resetIndex = 0;
    for (let index = 1; index < prior.length; index++) {
      if (prior[index]!.runs < prior[index - 1]!.runs) resetIndex = index;
    }
    if (resetIndex > 0) prior = prior.slice(resetIndex);
    if (prior.length > 0 && runs < prior[prior.length - 1]!.runs) prior = [];
    const updated = [...prior, { t: now, runs }];
    nextSamples[label] = updated;

    const exitLinePresent = /^\s*last exit code\s*=/m.test(output);
    const exitMatch = /^\s*last exit code\s*=\s*(-?\d+)\b/m.exec(output);
    const signalLinePresent = /^\s*last terminating signal\s*=/m.test(output);
    const signalMatch = /^\s*last terminating signal\s*=.*?:\s*(\d+)\s*$/m.exec(output);
    const crash = exitMatch
      ? Number(exitMatch[1]) !== 0
      : signalMatch
        ? Number(signalMatch[1]) > 0
        : false;
    const statusRecognized = exitMatch !== null || signalMatch !== null;
    const baseline = prior[0];
    const grewEnough = baseline !== undefined && runs - baseline.runs >= thresholds.crashRuns;

    if (grewEnough && crash) return result("fail", "crash loop");
    if (grewEnough && !statusRecognized && (exitLinePresent || signalLinePresent)) return result("unknown");
    return result("pass");
  });

  return { results, samples: nextSamples };
}

function matchesLabel(listener: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.-])${escaped}($|[^\\w.-])`).test(listener);
}

function processId(listener: string): string | undefined {
  const explicit = /(?:^|\s)pid\s*[=:]?\s*(\d+)\b/i.exec(listener);
  if (explicit) return explicit[1];
  const lsofColumns = /^\S+\s+(\d+)(?:\s|$)/.exec(listener);
  return lsofColumns?.[1];
}

function uniqueListeners(listeners: string[]): string[] {
  const seenPids = new Set<string>();
  const unique: string[] = [];
  for (const listener of listeners) {
    const pid = processId(listener);
    if (pid !== undefined) {
      if (seenPids.has(pid)) continue;
      seenPids.add(pid);
    }
    unique.push(listener);
  }
  return unique;
}

export function checkPorts(ports: Record<string, string>, probes: PortProbe[]): CheckResult[] {
  return probes.flatMap(({ port, listeners }): CheckResult[] => {
    const portName = String(port);
    const owner = ports[portName];
    if (owner === undefined) return [];
    const unique = uniqueListeners(listeners);
    const base = { id: "port.owner", subject: portName };
    if (unique.length === 0) return [{ ...base, status: "fail", reason: "nothing listens" }];
    const owned = unique.some((listener) => matchesLabel(listener, owner));
    if (!owned) return [{ ...base, status: "fail", reason: `listener is not ${owner}` }];
    if (unique.length > 1) return [{ ...base, status: "fail", reason: "foreign listener present" }];
    return [{ ...base, status: "pass" }];
  });
}

export function checkMeshJoin(status: number | null): CheckResult {
  if (status === null) return { id: "mesh.join", status: "unknown" };
  if (status === 401) return { id: "mesh.join", status: "pass" };
  if (status === 404) return { id: "mesh.join", status: "fail", reason: "meshService is off (join route 404)" };
  return { id: "mesh.join", status: "fail", reason: `unexpected status ${status}` };
}

export function checkHealth(id: string, status: number | null): CheckResult {
  if (status === null) return { id, status: "unknown" };
  if (status === 200) return { id, status: "pass" };
  return { id, status: "fail", reason: `unexpected status ${status}` };
}
