/**
 * pulse-anima-castle-migration — castle-side scheduler for the 4-stage
 * pulse-anima cycle. Wraps the existing, unchanged `pulse-anima-cycle.sh`
 * and `disruption-check.sh` scripts; does not port their logic.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createGardenEvent, type GardenEvent } from "../garden/events";
import { appendBeamEntries, type BeamEntry } from "../dream/light-nap";

export const PULSE_ANIMA_STAGES = ["observe", "reflect", "dream", "integrate"] as const;
export type PulseAnimaStage = (typeof PULSE_ANIMA_STAGES)[number];

export type PulseAnimaState = Record<PulseAnimaStage, { next: string }>;

/** Reads `state.json`'s per-stage rotation `next` field — the same file
 *  `pulse-anima-cycle.sh` already reads and updates. Does not reimplement
 *  the rotation logic, only reads its current result. */
export function readPulseAnimaState(stateFilePath: string): PulseAnimaState {
  let raw: string;
  try {
    raw = readFileSync(stateFilePath, "utf8");
  } catch {
    throw new Error(`pulse-anima state.json not found or unreadable: ${stateFilePath}`);
  }
  const parsed = JSON.parse(raw) as { cycles?: Record<string, { next?: unknown }> };
  const cycles = parsed.cycles ?? {};
  const result = {} as PulseAnimaState;
  for (const stage of PULSE_ANIMA_STAGES) {
    const next = cycles[stage]?.next;
    if (typeof next !== "string" || next.length === 0) {
      throw new Error(`pulse-anima state.json missing "next" agent for stage "${stage}"`);
    }
    result[stage] = { next };
  }
  return result;
}

/** Real per-stage output file names, matching
 *  pulse-anima-cycle.sh's own `OUTPUT_FILE` case statement. */
const STAGE_OUTPUT_FILES: Record<PulseAnimaStage, string> = {
  observe: "BRIDGE.md",
  reflect: "MIRROR.md",
  dream: "BROADCAST.md",
  integrate: "SUBSTRATE.md",
};

export function stageOutputFileName(stage: PulseAnimaStage): string {
  return STAGE_OUTPUT_FILES[stage];
}

const HEADER_SEPARATOR = /\r?\n===\r?\n/;
const SPOKEN_EXCERPT_MAX_CHARS = 220;
/** Below this fraction of the max, a "sentence boundary" this early in the
 *  text is more likely a stray period than a real sentence end — prefer the
 *  hard ellipsis truncation instead of cutting the excerpt implausibly short. */
const MIN_SENTENCE_BOUNDARY_FRACTION = 0.4;

/**
 * A stage's real output file (e.g. SUBSTRATE.md) is a full reflection
 * document — a `# <Stage> — <agent>` / `**Turn:**` / `**Model:**` /
 * `**Timestamp:**` header block, a `===` separator, then the actual
 * reflective body. Castle's room log (castle-room-log.ts) renders a
 * PULSE_STAGE_COMPLETED event's `text` as spoken dialogue — dumping the
 * whole document there reads as a wall of internal notes, not a room
 * conversation (the room showed agents standing idle with no dialogue).
 * This strips the header (if present — header-less text, as used
 * in tests/fallback markers, passes through) and shortens the body to a
 * spoken-length excerpt, preferring to end at a sentence boundary over a
 * mid-word hard cut.
 */
export function extractPulseStageSpokenLine(rawOutput: string): string {
  const match = rawOutput.match(HEADER_SEPARATOR);
  const body = (match ? rawOutput.slice(match.index! + match[0].length) : rawOutput).trim();
  if (body.length <= SPOKEN_EXCERPT_MAX_CHARS) return body;
  const window = body.slice(0, SPOKEN_EXCERPT_MAX_CHARS);
  const boundary = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"));
  if (boundary >= SPOKEN_EXCERPT_MAX_CHARS * MIN_SENTENCE_BOUNDARY_FRACTION) {
    return window.slice(0, boundary + 1);
  }
  const lastSpace = window.lastIndexOf(" ");
  const wordBoundary = lastSpace > 0 ? window.slice(0, lastSpace) : window;
  return `${wordBoundary.trimEnd()}…`;
}

export interface PulseAnimaStageDeps {
  store: { setPresence: (p: { agentId: string; placeId: string; since: number; activity?: string }) => void };
  eventStore: { append: (event: GardenEvent) => Promise<void> };
  /** Runs the unchanged `pulse-anima-cycle.sh <stage>` — injected so tests
   *  never spawn a real process. Production wiring is `createPulseAnimaDispatcher`. */
  runScript: (stage: PulseAnimaStage) => Promise<{ exitCode: number }>;
  /** Reads the stage's real output file after a successful run. */
  readOutput: (stage: PulseAnimaStage) => Promise<string>;
  /** Appends one beam entry to the agent's own staging/beams/. Requirement:
   *  one beam per pulse. Without beams, Deep Dream's daily report silently falls back to
   *  reading memory.db neurons instead. Injected like the other I/O here
   *  so tests never touch the real filesystem. */
  writeBeam: (agentId: string, beam: BeamEntry) => Promise<void>;
  now: () => number;
}

function pulseEvent<TPayload>(agentId: string, type: "PULSE_STAGE_STARTED" | "PULSE_STAGE_COMPLETED", payload: TPayload, now: number): GardenEvent<TPayload> {
  return createGardenEvent({
    id: randomUUID(),
    type,
    timestamp: new Date(now).toISOString(),
    agentId,
    instanceId: agentId,
    runtime: "hub",
    project: "castle",
    payload,
  });
}

/** Real castle action for one pulse-anima stage: presence + STARTED event,
 *  then the unchanged script, then COMPLETED with the real produced text
 *  (or a loud, non-throwing failure marker). Never ports the script's own
 *  logic. */
export async function runPulseAnimaStage(stage: PulseAnimaStage, agentId: string, deps: PulseAnimaStageDeps): Promise<{ exitCode: number }> {
  const now = deps.now();
  deps.store.setPresence({ agentId, placeId: "library", since: now, activity: `pulse:${stage}` });
  await deps.eventStore.append(pulseEvent(agentId, "PULSE_STAGE_STARTED", { stage }, now));

  const { exitCode } = await deps.runScript(stage);
  // Always try to read the output file, regardless of exit code.
  // pulse-anima-cycle.sh's check_quality() runs AFTER the content is already
  // written, and does `exit 1` on a failed quality gate without deleting the
  // file — a non-zero exit does not mean nothing was produced. Discarding
  // real content on any non-zero exit would lose valid output. Only report
  // failure when the file is genuinely unreadable.
  try {
    const raw = await deps.readOutput(stage);
    const text = extractPulseStageSpokenLine(raw);
    await deps.eventStore.append(pulseEvent(agentId, "PULSE_STAGE_COMPLETED", { stage, text }, deps.now()));
    // One beam per successful stage — not gated on light-nap's own
    // BEAM_KEYWORDS match, since a completed pulse-anima stage already IS
    // the judgment call that this content is worth keeping. But skip when
    // `text` is empty: pulse-anima-cycle.sh's own stasis detector (input
    // unchanged across consecutive cycles) can produce a header-only output
    // file — readable, so it doesn't hit the catch below, but empty after
    // header-stripping:
    // an empty beam is pure noise for Deep Dream's cross-referencing, not
    // a real reflection worth keeping.
    if (text.trim().length > 0) await deps.writeBeam(agentId, {
      timestamp: new Date(deps.now()).toISOString(),
      agent: agentId,
      session: `pulse:${stage}`,
      keywords: [stage],
      source: `pulse-anima:${stage}`,
      content: text,
    });
  } catch {
    await deps.eventStore.append(
      pulseEvent(agentId, "PULSE_STAGE_COMPLETED", { stage, text: `${stage} failed`, failed: true }, deps.now()),
    );
  }

  // Deliberately does NOT restore presence home here. Requirement: agents wait until
  // all agents have finished their work before going back to their rooms. The
  // whole session (all 4 stage-agents) stays visibly present in the room
  // together until the entire cycle (all 4 stages + disruption-check) is
  // done, not each agent leaving individually right after its own stage.
  // Restoration is the dispatcher's job (see PulseAnimaDispatcher.tick /
  // forceTick), run once at the very end of the cycle.
  return { exitCode };
}

/** Real schedule cadence (local hours) of the pulse-anima cycle, not the
 *  script's own stale "every 6h" header comment. Hours 1 and 22 are skipped
 *  to leave overnight room for the daily and weekly dream jobs and to
 *  interleave with the colony-mesh-talk schedule. */
const PULSE_ANIMA_SLOT_HOURS = new Set([4, 7, 10, 13, 16, 19]);

export interface PulseAnimaDispatcherDeps {
  readState: () => PulseAnimaState;
  runStage: (stage: PulseAnimaStage, agentId: string) => Promise<{ exitCode: number }>;
  /** Runs pulse-anima-pre.sh: the wrapper's inputs sync, external fetch,
   *  write-audit pre-cycles, digest-guard and SESSION_STARTED event
   *  (pulse-single-owner). */
  runPre: () => Promise<{ exitCode: number }>;
  /** Runs pulse-anima-post.sh: certifier, write-audit post-cycles,
   *  SESSION_ENDED event and the Hindsight digest retain. */
  runPost: () => Promise<{ exitCode: number }>;
  /** One garden-hub event per stage, with the wrapper's payload shape:
   *  TASK_COMPLETED {cycle} when ok, BLOCKER_REPORTED {cycle,status:"failed"}
   *  when not. */
  emitStageEvent: (stage: PulseAnimaStage, ok: boolean) => Promise<void>;
  /** Runs the unchanged disruption-check.sh — no presence/event of its own. */
  runDisruptionCheck: () => Promise<void>;
  /** Restores presence home for every agent who took part in this cycle's
   *  4 stages, called exactly once after the full cycle (all 4 stages +
   *  disruption-check) completes — see runPulseAnimaStage's comment for why
   *  this moved out of the per-stage function. */
  restoreHome: (agentIds: string[], priorPlaces?: Record<string, string>) => void;
  /** Where each stage-agent is RIGHT NOW, read before any stage moves anyone
   *  into library, so restoreHome can put them back where they were instead
   *  of always at their own chamber (castle-presence-persistence).
   *  Optional: absent = old behaviour (everyone goes home). */
  snapshotPlaces?: (agentIds: string[]) => Record<string, string>;
  /** Takes the slot claim (a directory shared with pulse-anima-kick.sh, so
   *  castle and the wrapper cannot both run a slot) — MUST survive a process
   *  restart. A plain in-memory field does not: every redeploy landing
   *  inside an already-fired hour would re-trigger the slot and generate a
   *  real duplicate LLM run each time. "exists" means the slot
   *  is already taken; any other failure throws. */
  claimSlot: (name: string) => "claimed" | "exists";
  /** The legacy DB mark castle used before the claim existed. Read only, so
   *  a deploy inside an already-fired hour does not run the slot again. */
  isSlotFired: (slotKey: string) => boolean;
  /** Where a failure in the sequence is reported. Default console.error. */
  log?: (message: string, error?: unknown) => void;
  /** Durable backstop for `restoreHome`'s in-memory 10-minute timer — see
   *  restoreOverdueAgentsHome's comment. Called unconditionally at the top
   *  of every tick(), regardless of the hour-slot gate below, so a missed
   *  restore is caught within one dispatch interval instead of staying
   *  stuck until someone notices. */
  checkOverdueRestores: () => void;
  /** Marks LIBRARY_ACTIVE_FLAG for the duration real occupants are in
   *  library — see that constant's comment for why room-scene-dispatcher.ts
   *  reads this instead of matching the occupant combo against a frozen
   *  snapshot of the rotations. */
  markLibraryActive: () => void;
  now: () => number;
}

/** Mirrors `ExpeditionDispatcher`'s shape (reflection-engine.ts): a `tick()`
 *  called on an interval by `ReflectionScheduler`. Fires the 4 stages
 *  sequentially — never in parallel — exactly once per configured hour
 *  slot, then the disruption check. */
export class PulseAnimaDispatcher {
  constructor(private readonly deps: PulseAnimaDispatcherDeps) {}

  async tick(): Promise<void> {
    this.deps.checkOverdueRestores();

    const now = new Date(this.deps.now());
    const hour = now.getHours();
    if (!PULSE_ANIMA_SLOT_HOURS.has(hour)) return;

    let claim: "claimed" | "exists";
    try {
      claim = this.deps.claimSlot(slotClaimName(now));
    } catch (err) {
      this.log("pulse-anima: slot claim failed, slot not run", err);
      return;
    }
    if (claim === "exists") return;
    // Handover from the old DB guard: the slot was already fired before this
    // deploy, so the claim is taken (above) and nothing runs.
    if (this.deps.isSlotFired(legacySlotKey(now))) return;

    await this.runSequence();
  }

  /** Manual, on-demand run — ignores the hour window and the slot claim
   *  entirely (neither reads nor creates one, so a later real `tick()` for
   *  the current slot still fires normally). Exists so verifying a fix never
   *  requires waiting up to 3 hours for the next real slot (the
   *  verification must not depend on wall-clock timing). */
  async forceTick(): Promise<void> {
    await this.runSequence();
  }

  private log(message: string, error?: unknown): void {
    (this.deps.log ?? ((m, e) => console.error(m, e ?? "")))(message, error);
  }

  /** Runs one step; a throw or a non-zero exit is logged and reported as not
   *  ok, never propagated — the rest of the sequence, post and the presence
   *  restore must still run (pulse-single-owner PO-3). */
  private async guard(label: string, step: () => Promise<{ exitCode: number } | void>): Promise<boolean> {
    try {
      const result = await step();
      const exitCode = result ? result.exitCode : 0;
      if (exitCode !== 0) {
        this.log(`pulse-anima: ${label} exited ${exitCode}`);
        return false;
      }
      return true;
    } catch (err) {
      this.log(`pulse-anima: ${label} failed`, err);
      return false;
    }
  }

  private async runSequence(): Promise<void> {
    this.deps.markLibraryActive();
    const state = this.deps.readState();
    const agentIds = PULSE_ANIMA_STAGES.map((stage) => state[stage].next);
    const priorPlaces = this.deps.snapshotPlaces?.(agentIds);
    await this.guard("pre", () => this.deps.runPre());
    for (const stage of PULSE_ANIMA_STAGES) {
      const ok = await this.guard(`stage ${stage}`, () => this.deps.runStage(stage, state[stage].next));
      await this.guard(`event ${stage}`, () => this.deps.emitStageEvent(stage, ok));
    }
    await this.guard("disruption-check", () => this.deps.runDisruptionCheck());
    await this.guard("post", () => this.deps.runPost());
    this.deps.restoreHome(agentIds, priorPlaces);
  }
}

/** `YYYY-MM-DD-HH` by system local time (the zone the kick script uses),
 *  zero-padded. The shared name of a slot's claim directory. */
export function slotClaimName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}`;
}

/** The pre-claim DB mark's key: zero-based, unpadded month. */
function legacySlotKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
}

/** The claim: `<pulseDir>/.slots/<name>`. The parent is ensured first, then
 *  the leaf is created non-recursively so only an existing claim reads as
 *  "exists" (a recursive mkdir would treat it as success and let two owners
 *  through). */
export function createSlotClaimer(pulseDir: string): (name: string) => "claimed" | "exists" {
  return (name) => {
    const slotsDir = join(pulseDir, ".slots");
    mkdirSync(slotsDir, { recursive: true });
    try {
      mkdirSync(join(slotsDir, name));
      return "claimed";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw err;
    }
  };
}

export interface PulseAnimaProductionOptions {
  /** Where the unchanged scripts live — not moved by this migration. */
  scriptDir: string;
  /** Re-rooted output location — passed as $PULSE_DIR, the
   *  script itself is not edited to hardcode this. */
  pulseDir: string;
  store: PulseAnimaStageDeps["store"] & {
    getMark: (key: string) => { value: string } | null;
    setMark: (key: string, value: string, setBy: string) => void;
    getPresence: (agentId: string) => { placeId: string; activity?: string | null } | null;
  };
  eventStore: PulseAnimaStageDeps["eventStore"];
  /** Agent rooms root — beams are written to `<roomsDir>/<agentId>/staging/
   *  beams/`, matching where Deep Dream's `readAgentBeams` already looks. */
  roomsDir: string;
}

const SLOT_FLAG_PREFIX = "pulse-anima-slot-fired:";

/** How long the 4 stage-agents linger in Library after work finishes,
 *  before going home. Requirement: after finishing work they stay around
 *  5-10 min to check things, so nobody leaves the moment they finish. */
export const PULSE_ANIMA_IDLE_MS = 10 * 60 * 1000;

/** Flag key holding the one pending restore (agentIds + due timestamp), if
 *  any. Single-slot, not a queue — real cycles are 3+ hours apart and the
 *  idle window is 10 minutes, so overlap only happens from back-to-back
 *  manual forceTick() calls, in which case the newer cycle's restore wins. */
const RESTORE_DUE_FLAG = "pulse-anima-restore-due";

/** Set for the entire window real pulse-anima stage-agents occupy library —
 *  from the moment a cycle starts until they're actually restored home
 *  (either the idle-linger timer or its durable backstop). room-scene-
 *  dispatcher.ts reads this instead of matching the current occupant combo
 *  against a frozen snapshot of the 4 rotations (pulse-anima-ticks.ts).
 *
 *  Each stage's rotation ("sequence") in state.json advances independently,
 *  so the 4 rotations drift out of phase with each other over time. Once
 *  drifted, the real combo no longer matches any hardcoded tuple, the guard
 *  would silently stop recognizing real pulse-anima ticks, and every tick
 *  would trigger a paid image generation. A live flag set by the actual
 *  dispatcher run cannot drift the way a frozen combo snapshot can. */
export const LIBRARY_ACTIVE_FLAG = "pulse-anima-library-active";

/** True only while a real pulse-anima cycle currently occupies library —
 *  see LIBRARY_ACTIVE_FLAG's comment. */
export function isLibraryActive(store: { getMark: (key: string) => { value: string } | null }): boolean {
  return store.getMark(LIBRARY_ACTIVE_FLAG)?.value === "1";
}

interface PendingRestore { agentIds: string[]; dueAt: number; priorPlaces?: Record<string, string> }

type RestoreMarkStore = PulseAnimaStageDeps["store"] & {
  getMark: (key: string) => { value: string } | null;
  setMark: (key: string, value: string, setBy: string) => void;
};

/** Where a restored agent goes: the place it was in before the cycle, or its
 *  own chamber when no usable snapshot exists (older durable flag, agent had
 *  no presence row, or the snapshot was itself an un-restored pulse state). */
function restoreTarget(agentId: string, priorPlaces?: Record<string, string>): string {
  return priorPlaces?.[agentId] ?? `chamber_${agentId}`;
}

/** Reads each agent's current place for `snapshotPlaces`. Skips agents with no
 *  presence row, and agents still in an un-restored pulse-library state —
 *  snapshotting that would just re-trap them in library. */
export function snapshotPriorPlaces(
  store: { getPresence: (agentId: string) => { placeId: string; activity?: string | null } | null },
  agentIds: string[],
): Record<string, string> {
  const places: Record<string, string> = {};
  for (const agentId of agentIds) {
    const presence = store.getPresence(agentId);
    if (!presence) continue;
    if (presence.placeId === "library" && presence.activity?.startsWith("pulse:")) continue;
    places[agentId] = presence.placeId;
  }
  return places;
}

/** Restores presence home for a cycle's agents after the idle linger —
 *  takes an injectable `schedule` so the delay is unit-testable without a
 *  real 10-minute wait. `tick()`/`forceTick()` still return as soon as the
 *  real work (stages + disruption-check) finishes; this runs independently
 *  afterward, so a manual force-tick call doesn't hang on the linger too.
 *
 *  Also persists the pending restore as a durable flag (RESTORE_DUE_FLAG),
 *  cleared once this in-memory timer actually fires. A plain setTimeout does
 *  not survive a process restart, which silently drops any pending timer, so
 *  stage-agents could stay in library past their idle window.
 *  restoreOverdueAgentsHome is the backstop that catches this on the next
 *  dispatcher tick(). */
export function scheduleRestoreHomeAfterIdle(
  store: RestoreMarkStore,
  agentIds: string[],
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => {
    setTimeout(fn, ms);
  },
  now: () => number = Date.now,
  priorPlaces?: Record<string, string>,
): void {
  store.setMark(RESTORE_DUE_FLAG, JSON.stringify({ agentIds, dueAt: now() + PULSE_ANIMA_IDLE_MS, priorPlaces } satisfies PendingRestore), "pulse-anima-dispatcher");
  schedule(() => {
    for (const agentId of agentIds) {
      store.setPresence({ agentId, placeId: restoreTarget(agentId, priorPlaces), since: now() });
    }
    store.setMark(RESTORE_DUE_FLAG, "", "pulse-anima-dispatcher");
    store.setMark(LIBRARY_ACTIVE_FLAG, "", "pulse-anima-dispatcher");
  }, PULSE_ANIMA_IDLE_MS);
}

/** Durable backstop for scheduleRestoreHomeAfterIdle's in-memory timer —
 *  see its comment. Reads the one pending restore (if any); if it's overdue,
 *  restores those agents home for real and consumes the flag. Safe to call
 *  on every dispatcher tick() (every 5 minutes, per ReflectionScheduler),
 *  including when there's nothing pending. */
export function restoreOverdueAgentsHome(store: RestoreMarkStore, now: () => number = Date.now): void {
  const flag = store.getMark(RESTORE_DUE_FLAG);
  if (!flag || !flag.value) return;
  let pending: PendingRestore;
  try {
    pending = JSON.parse(flag.value);
  } catch {
    return;
  }
  if (now() < pending.dueAt) return;
  for (const agentId of pending.agentIds) {
    store.setPresence({ agentId, placeId: restoreTarget(agentId, pending.priorPlaces), since: now() });
  }
  store.setMark(RESTORE_DUE_FLAG, "", "pulse-anima-dispatcher");
  store.setMark(LIBRARY_ACTIVE_FLAG, "", "pulse-anima-dispatcher");
}

export async function runShellScript(scriptDir: string, pulseDir: string, scriptName: string, ...args: string[]): Promise<{ exitCode: number }> {
  const proc = Bun.spawn(["bash", scriptName, ...args], {
    cwd: scriptDir,
    env: { ...process.env, PULSE_DIR: pulseDir },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  return { exitCode };
}

/** Real production wiring: unchanged `pulse-anima-cycle.sh`/
 *  `disruption-check.sh`, with output re-rooted via $PULSE_DIR. */
export function createPulseAnimaDispatcher(opts: PulseAnimaProductionOptions): PulseAnimaDispatcher {
  const stateFilePath = join(opts.scriptDir, "state.json");
  return new PulseAnimaDispatcher({
    readState: () => readPulseAnimaState(stateFilePath),
    runStage: (stage, agentId) =>
      runPulseAnimaStage(stage, agentId, {
        store: opts.store,
        eventStore: opts.eventStore,
        runScript: () => runShellScript(opts.scriptDir, opts.pulseDir, "pulse-anima-cycle.sh", stage),
        readOutput: async (s) =>
          readFileSync(join(opts.pulseDir, "cycles", s, "current", stageOutputFileName(s)), "utf8"),
        writeBeam: (id, beam) => appendBeamEntries(join(opts.roomsDir, id), [beam]),
        now: () => Date.now(),
      }),
    runPre: () => runShellScript(opts.scriptDir, opts.pulseDir, "pulse-anima-pre.sh"),
    runPost: () => runShellScript(opts.scriptDir, opts.pulseDir, "pulse-anima-post.sh"),
    emitStageEvent: async (stage, ok) => {
      const { exitCode } = await runShellScript(opts.scriptDir, opts.pulseDir, "pulse-anima-stage-event.sh", stage, ok ? "ok" : "failed");
      if (exitCode !== 0) throw new Error(`pulse-anima-stage-event.sh exited ${exitCode}`);
    },
    claimSlot: createSlotClaimer(opts.pulseDir),
    isSlotFired: (slotKey) => opts.store.getMark(SLOT_FLAG_PREFIX + slotKey) !== null,
    runDisruptionCheck: async () => {
      await runShellScript(opts.scriptDir, opts.pulseDir, "disruption-check.sh");
    },
    snapshotPlaces: (agentIds) => snapshotPriorPlaces(opts.store, agentIds),
    restoreHome: (agentIds, priorPlaces) => scheduleRestoreHomeAfterIdle(opts.store, agentIds, undefined, undefined, priorPlaces),
    checkOverdueRestores: () => restoreOverdueAgentsHome(opts.store),
    markLibraryActive: () => opts.store.setMark(LIBRARY_ACTIVE_FLAG, "1", "pulse-anima-dispatcher"),
    now: () => Date.now(),
  });
}
