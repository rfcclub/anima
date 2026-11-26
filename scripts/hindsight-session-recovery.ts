#!/usr/bin/env bun
/**
 * Local recovery for Hindsight session write-backs that failed while the server was down.
 *
 * The plugin is a third-party package, so it is not patched here. Instead this reads the
 * `retain_failed` diagnostics it leaves behind, replays the retain for every failed session
 * whose transcript still exists, and reports the rest loudly. Replay is idempotent: the
 * document id is `conversation:<session id>`, so a second run cannot duplicate a session.
 *
 * Usage: bun scripts/hindsight-session-recovery.ts [--apply]
 * Dry run by default: nothing is sent and no state is written without --apply.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One `retain_failed` diagnostic the plugin wrote. */
export interface RetainFailure {
  sessionId: string;
  at: number;
}

export interface RecoveryState {
  version: 1;
  /** Newest diagnostic timestamp already handled. A later run only looks past it. */
  lastRunAt: number;
  /** session id -> "retained" | "unrecoverable"; keeps a replay and its report single-shot. */
  outcomes: Record<string, "retained" | "unrecoverable">;
  /** Set when a failure was seen but the banner has not been shown yet. */
  banner?: string;
}

export interface RecoverDeps {
  /** The plugin's diagnostics, newest last. Missing file = no failures. */
  readDiagnostics(): string;
  /** The session's transcript, or undefined when it is gone. */
  readTranscript(sessionId: string): string | undefined;
  /** Replays one retain; idempotent on `conversation:<session id>`. */
  retain(sessionId: string, transcript: string): Promise<void>;
  /** Receives every line the step would print. */
  report(line: string): void;
}

const EVENT_NAMES = new Set(["retain_failed", "retain-failed"]);
const SESSION = /^[A-Za-z0-9._:-]{1,200}$/;

export function emptyState(): RecoveryState {
  return { version: 1, lastRunAt: 0, outcomes: {} };
}

/** `retain_failed` events from the diagnostics, oldest first. Unparseable lines are skipped. */
export function parseRetainFailures(text: string): RetainFailure[] {
  const out: RetainFailure[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const event = row.event ?? row.type ?? row.kind;
    if (typeof event !== "string" || !EVENT_NAMES.has(event)) continue;
    const sessionId = row.session_id ?? row.sessionId ?? row.session;
    if (typeof sessionId !== "string" || !SESSION.test(sessionId)) continue;
    const raw = row.timestamp ?? row.at ?? row.time;
    const at = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
    out.push({ sessionId, at: Number.isFinite(at) ? at : 0 });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function loadState(path: string): RecoveryState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RecoveryState>;
    if (parsed.version !== 1 || !Number.isFinite(parsed.lastRunAt)) return emptyState();
    const outcomes: RecoveryState["outcomes"] = {};
    for (const [id, value] of Object.entries(parsed.outcomes ?? {})) {
      if ((value === "retained" || value === "unrecoverable") && SESSION.test(id)) outcomes[id] = value;
    }
    const banner = typeof parsed.banner === "string" ? parsed.banner : undefined;
    return { version: 1, lastRunAt: parsed.lastRunAt as number, outcomes, ...(banner ? { banner } : {}) };
  } catch {
    return emptyState();
  }
}

/** Atomic replace, mode 0600: the state names sessions but carries no transcript text. */
export function saveState(path: string, state: RecoveryState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Handles every failure newer than the last run once. A retained session is reported and
 * remembered; a session whose transcript is gone is reported as unrecoverable and never
 * retried. Returns the state to persist; with `apply` false nothing is mutated but the report
 * still describes what a real run would do.
 */
export async function recoverOnce(
  state: RecoveryState,
  failures: RetainFailure[],
  deps: Pick<RecoverDeps, "readTranscript" | "retain" | "report">,
  options: { apply: boolean; now: number },
): Promise<RecoveryState> {
  const next: RecoveryState = { version: 1, lastRunAt: state.lastRunAt, outcomes: { ...state.outcomes }, ...(state.banner ? { banner: state.banner } : {}) };
  const pending = failures.filter((failure) => failure.at > state.lastRunAt);

  // The watermark may only move over settled failures, and only from the oldest forward:
  // advancing past one that is still unsettled would hide it from every later run, which
  // is the silent drop this step exists to prevent.
  let blocked = false;
  const settle = (at: number) => {
    if (!blocked) next.lastRunAt = Math.max(next.lastRunAt, at);
  };

  for (const failure of pending) {
    const { sessionId, at } = failure;
    if (next.outcomes[sessionId]) {
      settle(at);
      continue;
    }
    const transcript = deps.readTranscript(sessionId);
    if (transcript === undefined) {
      deps.report(`hindsight recovery: session ${sessionId} cannot be recovered (transcript gone)`);
      next.outcomes[sessionId] = "unrecoverable";
      settle(at);
      continue;
    }
    if (!options.apply) {
      deps.report(`hindsight recovery: would retain session ${sessionId}`);
      blocked = true;
      continue;
    }
    try {
      await deps.retain(sessionId, transcript);
      deps.report(`hindsight recovery: retained session ${sessionId}`);
      next.outcomes[sessionId] = "retained";
      settle(at);
    } catch (err) {
      // Reported, left without an outcome, and the watermark stays below it: the next run
      // retries this session instead of forgetting it.
      deps.report(`hindsight recovery: retain failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      blocked = true;
    }
  }

  if (pending.length > 0) {
    // One banner per outage: it is cleared only when a session reads it.
    next.banner = `hindsight: ${pending.length} session write-back failure${pending.length === 1 ? "" : "s"} to recover`;
  }
  return next;
}

/** The banner text a starting session should show, or undefined when there is nothing to say. */
export function takeBanner(state: RecoveryState): { banner: string | undefined; state: RecoveryState } {
  return { banner: state.banner, state: { ...state, banner: undefined } };
}

/**
 * Reads the banner once from the saved state and clears it in the same write, so the outage
 * is announced to exactly one starting session. A missing or corrupt state says nothing.
 */
export function consumeBanner(path: string): string | undefined {
  const state = loadState(path);
  if (!state.banner) return undefined;
  const { banner, ...rest } = state;
  saveState(path, rest);
  return banner;
}

// ── Endpoint and defaults ────────────────────────────────────────────────────

const DEFAULT_CONFIG_PATH = join(homedir(), ".hindsight", "coding-agent.json");
const DEFAULT_STATE_PATH = join(homedir(), ".anima", "hindsight-recovery.json");
const DEFAULT_DIAGNOSTICS_PATH = join(homedir(), ".hindsight", "diagnostics.jsonl");
const DEFAULT_TRANSCRIPTS_DIR = join(homedir(), ".hindsight", "transcripts");

interface HindsightConfig {
  apiUrl: string;
  apiToken?: string;
}

function readConfig(path = DEFAULT_CONFIG_PATH): HindsightConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { apiUrl?: unknown; apiToken?: unknown };
    if (typeof parsed.apiUrl !== "string" || !parsed.apiUrl) return null;
    return { apiUrl: parsed.apiUrl, apiToken: typeof parsed.apiToken === "string" ? parsed.apiToken : undefined };
  } catch {
    return null;
  }
}

/** Same bank the recall leg uses: `coding-agent::<project>`. */
function bankFor(project: string): string {
  return Bun.env.HINDSIGHT_BANK ?? `coding-agent::${project}`;
}

/**
 * Replays one retain. The document id is `conversation:<session id>`, so replaying a session
 * that already went out replaces the same document instead of adding a second one.
 */
export async function retainSession(
  opts: { apiUrl: string; apiToken?: string; bank: string; fetchFn?: typeof fetch; timeoutMs?: number },
  sessionId: string,
  transcript: string,
): Promise<void> {
  const base = opts.apiUrl.replace(/\/+$/, "");
  const url = `${base}/v1/default/banks/${encodeURIComponent(opts.bank)}/documents`;
  const res = await (opts.fetchFn ?? fetch)(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.apiToken ? { Authorization: `Bearer ${opts.apiToken}` } : {}),
    },
    body: JSON.stringify({ document_id: `conversation:${sessionId}`, content: transcript }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  if (!res.ok) throw new Error(`retain failed (${res.status})`);
}

function projectName(cwd: string): string {
  try {
    const top = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { stderr: "ignore" }).stdout.toString().trim();
    return (top.split("/").pop() || cwd.split("/").pop() || "unknown").replace(/[^A-Za-z0-9._-]/g, "-");
  } catch {
    return (cwd.split("/").pop() || "unknown").replace(/[^A-Za-z0-9._-]/g, "-");
  }
}

if (import.meta.main) {
  const apply = Bun.argv.includes("--apply");
  const statePath = Bun.env.HINDSIGHT_RECOVERY_STATE ?? DEFAULT_STATE_PATH;
  const diagnosticsPath = Bun.env.HINDSIGHT_DIAGNOSTICS ?? DEFAULT_DIAGNOSTICS_PATH;
  const transcriptsDir = Bun.env.HINDSIGHT_TRANSCRIPTS_DIR ?? DEFAULT_TRANSCRIPTS_DIR;
  const config = readConfig();

  const state = loadState(statePath);
  const failures = existsSync(diagnosticsPath) ? parseRetainFailures(readFileSync(diagnosticsPath, "utf8")) : [];
  const next = await recoverOnce(
    state,
    failures,
    {
      readTranscript: (sessionId) => {
        const path = join(transcriptsDir, `${sessionId}.jsonl`);
        return existsSync(path) ? readFileSync(path, "utf8") : undefined;
      },
      retain: async (sessionId, transcript) => {
        if (!config) throw new Error("no Hindsight apiUrl configured");
        await retainSession({ apiUrl: config.apiUrl, apiToken: config.apiToken, bank: bankFor(projectName(process.cwd())) }, sessionId, transcript);
      },
      report: (line) => {
        if (apply) console.log(line);
        else console.log(`[dry-run] ${line}`);
      },
    },
    { apply, now: Date.now() },
  );

  if (apply) {
    saveState(statePath, next);
    if (next.banner) {
      // Also leaves the banner where the next session's boot context can read it.
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
      appendFileSync(join(dirname(statePath), "hindsight-recovery.banner"), `${next.banner}\n`, { mode: 0o600 });
    }
  } else if (failures.length === 0) {
    console.log("hindsight recovery: no failures");
  }
}
