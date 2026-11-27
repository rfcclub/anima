import type { AgentMemoryStore } from "../memory/contract";
import type { ProposalInbox } from "../memory/proposal-inbox.ts";
import type {
  RemoteConsolidateRequest,
  RemoteConsolidateResult,
} from "./contract/remote-continuity.ts";

/** Tag carrying the durable identity of one remote batch (session id plus sequence). */
export function remoteBatchTag(sessionId: string, sequence: number): string {
  return `remote-session:${sessionId}:${sequence}`;
}

export interface RemoteConsolidationOptions {
  agentId: string;
  /** The agent's own canonical store. Only the summary is ever written through it. */
  store: Pick<AgentMemoryStore, "remember" | "findByTag">;
  /** The agent's inbox of proposals (#666). Candidate learnings go here and nowhere else. */
  inbox: Pick<ProposalInbox, "append">;
}

/**
 * Applies one remote session-end batch: the agent's own summary becomes an
 * episode entry, and every candidate learning becomes an untrusted inbox
 * proposal. Nothing a remote host sends reaches the substrate: the agent's
 * own reflection decides what, if anything, is promoted from the inbox.
 *
 * A batch is identified by its session id plus sequence, so a retry (even
 * after an unknown-outcome failure) never writes a second episode.
 */
export function remoteConsolidate(
  options: RemoteConsolidationOptions,
): (request: RemoteConsolidateRequest, context: { surfaceId: string }) => Promise<RemoteConsolidateResult> {
  return async ({ batch }, { surfaceId }) => {
    const tag = remoteBatchTag(batch.sessionId, batch.sequence);
    const existing = await options.store.findByTag?.(tag);
    const episode = existing ?? await options.store.remember({
      scope: "episode",
      content: batch.summary,
      tags: [tag, "remote-session", "untrusted"],
      confidence: 0.5,
      source: `remote:${surfaceId}`,
      metadata: {
        remote_surface: surfaceId,
        remote_session_id: batch.sessionId,
        remote_sequence: batch.sequence,
        untrusted: true,
      },
    });

    let proposals = 0;
    let duplicates = 0;
    for (const candidate of batch.candidates ?? []) {
      const outcome = options.inbox.append(options.agentId, candidate.claim, {
        kind: "remote-session",
        source: surfaceId,
        sessionId: batch.sessionId,
        sequence: batch.sequence,
        evidence: candidate.evidence,
        confidence: candidate.confidence,
      });
      if (outcome.status === "appended") proposals++;
      else duplicates++;
    }
    return { episodeId: episode.id, proposals, duplicates };
  };
}
