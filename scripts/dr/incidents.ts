import type { CheckResult, State } from "./types.ts";

export interface IncidentEvent {
  kind: "opened" | "closed";
  key: string;
  reason: string;
}

const rank = (status: CheckResult["status"]): number => (status === "fail" ? 2 : status === "pass" ? 1 : 0);

export function reduceIncidents(
  state: State,
  results: CheckResult[],
  now: number,
): { state: State; events: IncidentEvent[] } {
  const next: State = {
    ...state,
    failCount: { ...state.failCount },
    incidents: { ...state.incidents },
    restarts: { ...state.restarts },
    runSamples: { ...state.runSamples },
    presenceSince: { ...state.presenceSince },
    queue: [...state.queue],
  };
  const events: IncidentEvent[] = [];

  // One run counts once per key, however many results it holds: a failure beats a pass, and a pass beats unknown.
  const byKey = new Map<string, CheckResult>();
  for (const result of results) {
    const key = `${result.id}|${result.subject ?? ""}`;
    const seen = byKey.get(key);
    if (!seen || rank(result.status) > rank(seen.status)) byKey.set(key, result);
  }

  for (const [key, result] of byKey) {
    if (result.status === "unknown") continue;

    if (result.status === "pass") {
      next.failCount[key] = 0;
      if (next.incidents[key]) {
        delete next.incidents[key];
        events.push({ kind: "closed", key, reason: "recovered" });
      }
      continue;
    }

    const failures = (next.failCount[key] ?? 0) + 1;
    next.failCount[key] = failures;
    if (failures >= 2 && !next.incidents[key]) {
      const reason = result.reason ?? "failed";
      next.incidents[key] = {
        openedAt: now,
        reason,
        alertSent: false,
        capAlertSent: false,
      };
      events.push({ kind: "opened", key, reason });
    }
  }

  return { state: next, events };
}
