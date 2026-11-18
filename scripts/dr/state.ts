import type { Fs, State } from "./types.ts";

function emptyState(): State {
  return {
    version: 1,
    failCount: {},
    incidents: {},
    restarts: {},
    runSamples: {},
    presenceSince: {},
    queue: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isState(value: unknown): value is State {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!isRecord(value.failCount) || !isRecord(value.incidents) || !isRecord(value.restarts)
    || !isRecord(value.runSamples) || !isRecord(value.presenceSince) || !Array.isArray(value.queue)) return false;
  if (value.lastGoodHash !== undefined && typeof value.lastGoodHash !== "string") return false;
  if (Object.values(value.failCount).some((count) => typeof count !== "number" || !Number.isInteger(count) || count < 0)) return false;
  if (Object.values(value.restarts).some((times) => !Array.isArray(times) || times.some((time) => typeof time !== "number" || !Number.isFinite(time)))) return false;
  if (Object.values(value.runSamples).some((samples) => !Array.isArray(samples) || samples.some((sample) =>
    !isRecord(sample) || typeof sample.t !== "number" || !Number.isFinite(sample.t)
      || typeof sample.runs !== "number" || !Number.isFinite(sample.runs)))) return false;
  if (Object.values(value.presenceSince).some((time) => typeof time !== "number" || !Number.isFinite(time))) return false;
  if (Object.values(value.incidents).some((incident) => !isRecord(incident)
    || typeof incident.openedAt !== "number" || !Number.isFinite(incident.openedAt) || typeof incident.reason !== "string"
    || typeof incident.alertSent !== "boolean" || typeof incident.capAlertSent !== "boolean")) return false;
  return value.queue.every((event) => isRecord(event)
    && ["open", "recovered", "cap", "last-good-invalid"].includes(String(event.kind))
    && typeof event.key === "string" && typeof event.text === "string");
}

export function loadState(fs: Fs, path: string): State {
  const contents = fs.read(path);
  if (contents === undefined) return emptyState();
  try {
    const parsed: unknown = JSON.parse(contents);
    if (isState(parsed)) return parsed;
  } catch {
    // Invalid JSON follows the same quarantine path as invalid state structure.
  }

  // Preserve the corrupt file without letting quarantine errors prevent startup.
  try {
    let aside = `${path}.corrupt`;
    for (let suffix = 1; fs.read(aside) !== undefined; suffix++) aside = `${path}.corrupt.${suffix}`;
    fs.rename(path, aside);
  } catch {
    // An unreadable/unmovable corrupt file still must not stop the watchdog.
  }
  return emptyState();
}

export function saveState(fs: Fs, path: string, state: State): void {
  const temporary = `${path}.tmp`;
  fs.write(temporary, JSON.stringify(state));
  fs.chmod(temporary, 0o600);
  fs.rename(temporary, path);
  fs.chmod(path, 0o600);
}
