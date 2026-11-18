import type { Config } from "./config.ts";
import type { CheckResult, State } from "./types.ts";

export type Action =
  | { kind: "kickstart"; label: string }
  | { kind: "alert-cap"; label: string }
  | { kind: "alert-crashloop"; label: string }
  | { kind: "alert-port"; label: string; port: string };

const rank = (status: CheckResult["status"]): number => (status === "fail" ? 2 : status === "pass" ? 1 : 0);

export function decideRestarts(
  state: State,
  results: CheckResult[],
  config: Pick<Config, "owned" | "thresholds">,
  now: number,
): { state: State; actions: Action[] } {
  const next: State = {
    ...state,
    failCount: { ...state.failCount },
    incidents: Object.fromEntries(Object.entries(state.incidents).map(([key, incident]) => [key, { ...incident }])),
    restarts: Object.fromEntries(Object.entries(state.restarts).map(([label, times]) => [label, [...times]])),
    runSamples: Object.fromEntries(Object.entries(state.runSamples).map(([key, samples]) => [
      key,
      samples.map((sample) => ({ ...sample })),
    ])),
    presenceSince: { ...state.presenceSince },
    queue: state.queue.map((event) => ({ ...event })),
  };

  // Match the reducer's per-key duplicate handling: failure beats pass, pass beats unknown.
  const byKey = new Map<string, CheckResult>();
  for (const result of results) {
    const key = `${result.id}|${result.subject ?? ""}`;
    const seen = byKey.get(key);
    if (!seen || rank(result.status) > rank(seen.status)) byKey.set(key, result);
  }

  const actions: Action[] = [];
  const windowMs = config.thresholds.restartWindowMinutes * 60_000;

  const restartableIncidentKeys = (label: string): string[] => Object.keys(next.incidents).filter((key) => {
    const separator = key.indexOf("|");
    const id = key.slice(0, separator);
    return separator >= 0 && key.slice(separator + 1) === label
      && (id === "launchd.loaded" || id.startsWith("health."));
  });

  for (const label of new Set(config.owned)) {
    let suppressRestart = false;
    const restartable: string[] = [];

    for (const result of byKey.values()) {
      // Comparing the complete constructed key avoids suffix matches for labels containing '|'.
      const key = `${result.id}|${label}`;
      if (result.subject !== label || !next.incidents[key] || result.status !== "fail") continue;

      if (result.id === "launchd.crashloop") {
        const incident = next.incidents[key]!;
        suppressRestart = true;
        if (!incident.alertSent) {
          actions.push({ kind: "alert-crashloop", label });
          incident.alertSent = true;
        }
      } else if (result.id === "port.owner") {
        const incident = next.incidents[key]!;
        suppressRestart = true;
        if (!incident.alertSent) {
          actions.push({ kind: "alert-port", label, port: String(result.detail?.port ?? "unknown") });
          incident.alertSent = true;
        }
      } else if (result.id === "launchd.loaded" || result.id.startsWith("health.")) {
        restartable.push(key);
      }
    }

    if (suppressRestart || restartable.length === 0) continue;

    const restarts = (next.restarts[label] ?? []).filter((time) => time >= now - windowMs);
    next.restarts[label] = restarts;
    if (restarts.length < config.thresholds.restartCap) {
      restarts.push(now);
      actions.push({ kind: "kickstart", label });
      continue;
    }

    const incidents = restartableIncidentKeys(label).map((key) => next.incidents[key]!);
    if (incidents.some((incident) => incident.capAlertSent)) {
      for (const incident of incidents) incident.capAlertSent = true;
      continue;
    }
    actions.push({ kind: "alert-cap", label });
    for (const incident of incidents) incident.capAlertSent = true;
  }

  return { state: next, actions };
}
