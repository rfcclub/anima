import { VISIT_MARK_TTL_MS } from "../narrative/automation-marks";
import type { SharedNarrativeStore } from "../narrative/shared-store";

export const DIGEST_INTERVAL_MS = 6 * 60 * 60 * 1000;
const VISIT_DEDUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DIGEST_MAX_AGENTS = 8;
const DIGEST_VALUE_CLIP = 120;

export interface ColonyDigest {
  agent: string;
  digest: string;
}

/** Publish a one-line activity digest for an agent (no LLM call).
 *  Cadence-gated: skips if last-digest is within DIGEST_INTERVAL_MS. */
export function publishActivityDigest(
  store: SharedNarrativeStore,
  agentId: string,
  now: number,
): void {
  const last = store.getMark(`${agentId}:last-digest`);
  if (last && Number(last.value) > now - DIGEST_INTERVAL_MS) return;

  const lastAction = store.getMark(`${agentId}:last-action`);
  const agoraThreads = store.getThreadsForAgent(agentId).filter((t) => t.label === "post-agora");
  const lastPost = agoraThreads.length > 0 ? agoraThreads[0].value : null;

  const parts: string[] = [];
  if (lastAction) parts.push(lastAction.value);
  if (lastPost) parts.push(`"${lastPost.slice(0, DIGEST_VALUE_CLIP)}"`);
  const digest = parts.length > 0 ? parts.join(" ") : "idle";

  store.setMark(`${agentId}:digest`, digest, agentId);
  store.setMark(`${agentId}:last-digest`, String(now), agentId);
}

/** Read other agents' digests (bounded, excludes self). */
export function readColonyDigests(
  store: SharedNarrativeStore,
  selfAgentId: string,
): ColonyDigest[] {
  const all = store.listMarks("");
  const digests: ColonyDigest[] = [];
  for (const flag of all) {
    const m = flag.key.match(/^(.+):digest$/);
    if (!m) continue;
    const agent = m[1];
    if (agent === selfAgentId) continue;
    digests.push({ agent, digest: flag.value });
    if (digests.length >= DIGEST_MAX_AGENTS) break;
  }
  return digests;
}

/** Record a visiting trace when an agent leaves a room they were visiting.
 *  Deduped per (visitor, owner) per VISIT_DEDUP_INTERVAL_MS. */
export function recordVisitTrace(
  store: SharedNarrativeStore,
  visitorId: string,
  placeId: string,
  note: string,
  now: number,
): void {
  // Only trace visits to other agents' chambers (not own, not public places).
  const m = placeId.match(/^chamber_(.+)$/);
  if (!m) return;
  const owner = m[1];
  if (owner === visitorId) return; // leaving own chamber = going home, not a visit

  // Dedup: one visit thread per (visitor, owner) per interval
  const dedupKey = `visit-dedup:${visitorId}:${owner}`;
  const last = store.getMark(dedupKey);
  if (last && Number(last.value) > now - VISIT_DEDUP_INTERVAL_MS) return;

  store.recordThread({
    id: `visit-${visitorId}-${owner}-${now}`,
    fromAgent: visitorId,
    toAgent: owner,
    label: "visit",
    value: note,
  });
  store.setMark(dedupKey, String(now), visitorId, VISIT_MARK_TTL_MS);
}

/** Read recent visit threads addressed to an agent (as room owner). */
export function readVisitorTraces(
  store: SharedNarrativeStore,
  ownerAgentId: string,
): Array<{ fromAgent: string; value: string; timestamp: string }> {
  return store
    .getThreadsForAgent(ownerAgentId)
    .filter((t) => t.label === "visit" && t.toAgent === ownerAgentId)
    .map((t) => ({ fromAgent: t.fromAgent, value: t.value, timestamp: t.timestamp }));
}

