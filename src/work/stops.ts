/**
 * Stop records, trusted checkpoints and the continuation gate (rfcclub/anima#238, cartridge-worker-dispatch,
 * slice 5: AC-8, AC-9, AC-10).
 *
 * Every session end leaves a stop record: the stop cause, whether cessation was proven (and which check failed when
 * it was not), and the head, status and evidence, each a value or explicitly `unknown`, `unavailable` or
 * `untrusted`. A record is a trusted checkpoint only when cessation is proven, the lease and generation still hold
 * and the tree reads succeed under the sandboxed tree-git. Nothing here invents a cause or a checkpoint: a session
 * a host crash left open is recorded as interrupted with what is unknown.
 */

import { join } from "node:path";
import type { SessionRecord, StopRecord, WorkRecord, WorkStore } from "./store";

/** Read-only git on a work tree; throws when the command fails. Production: `readTreeGit` (sandboxed, neutral). */
export type TreeRead = (tree: string, args: string[]) => string;

export interface StopInput {
  work: WorkRecord;
  session: SessionRecord;
  adapter: string;
  stopCause: string;
  cessation: "proven" | "unproven";
  /** The check that failed when cessation is unproven. */
  cessationCheck?: string;
  leaseHeld: boolean;
  generationCurrent: boolean;
}

/** Evidence is validated in slice 6; until then a record carries none. */
const NO_EVIDENCE = "unavailable";

const HEAD_ARGS = ["rev-parse", "HEAD"];
const STATUS_ARGS = ["status", "--porcelain", "--untracked-files=all"];

const treeOf = (work: WorkRecord) => join(work.root, "tree");

export function createStopRecorder(deps: { store: WorkStore; read: TreeRead }): (input: StopInput) => StopRecord {
  return (input) => {
    const base = {
      sessionId: input.session.sessionId,
      workId: input.work.workId,
      adapter: input.adapter,
      stopCause: input.stopCause,
      cessation: input.cessation,
      cessationCheck: input.cessation === "proven" ? null : input.cessationCheck ?? "unspecified",
      evidence: NO_EVIDENCE,
      interrupted: false,
    };
    // Without proven cessation and the fence, whatever the tree shows may still change or is not ours to take.
    if (input.cessation !== "proven" || !input.leaseHeld || !input.generationCurrent) {
      return deps.store.recordStop({ ...base, head: "untrusted", status: "untrusted", trusted: false });
    }
    let head: string;
    let status: string;
    try {
      head = deps.read(treeOf(input.work), HEAD_ARGS).trim();
      status = deps.read(treeOf(input.work), STATUS_ARGS);
    } catch {
      return deps.store.recordStop({ ...base, head: "unavailable", status: "unavailable", trusted: false });
    }
    return deps.store.recordStop({ ...base, head, status, trusted: true });
  };
}

/**
 * After a host crash and `recoverOpenSessions`: an interrupted record for each recovered session that has none,
 * with nothing observed. A work whose session ran an external adapter blocks until an explicit recovery; adapter #0
 * keeps today's step reconciliation (Owner chose A, Telegram 21546). Returns the records written.
 */
export function recordInterruptedStops(store: WorkStore): StopRecord[] {
  const written: StopRecord[] = [];
  for (const session of store.unrecordedEndedSessions()) {
    const adapter = store.sessionAdapter(session.sessionId) ?? "loop";
    const block = adapter !== "loop"
      ? `session ${session.no} interrupted by a host crash: no trusted checkpoint, explicit recovery needed`
      : null;
    written.push(store.recordInterruptedStop({
      sessionId: session.sessionId,
      workId: session.workId,
      adapter,
      stopCause: "unknown",
      cessation: "unproven",
      cessationCheck: "host-crash",
      head: "unknown",
      status: "unknown",
      evidence: "unknown",
      trusted: false,
      interrupted: true,
    }, block));
  }
  return written;
}

/** Whether a new session may start on the work's tree (AC-10). */
export function checkContinuation(store: WorkStore, work: WorkRecord, read: TreeRead): { ok: true } | { ok: false; reason: string } {
  const session = store.latestEndedSession(work.workId);
  if (!session) return { ok: true };
  const latest = store.getStop(session.sessionId);
  if (!latest) return { ok: false, reason: `recovery needed: session ${session.no} ended with no stop record` };
  if (!latest.trusted) {
    return { ok: false, reason: `recovery needed: session stop has no trusted checkpoint (${latest.interrupted ? "interrupted" : latest.stopCause})` };
  }
  let head: string;
  let status: string;
  try {
    head = read(treeOf(work), HEAD_ARGS).trim();
    status = read(treeOf(work), STATUS_ARGS);
  } catch {
    return { ok: false, reason: "recovery needed: the work tree cannot be read" };
  }
  if (head !== latest.head) return { ok: false, reason: `recovery needed: the tree head ${head} does not match the checkpoint ${latest.head}` };
  if (status !== latest.status) return { ok: false, reason: "recovery needed: the tree status does not match the checkpoint" };
  return { ok: true };
}
