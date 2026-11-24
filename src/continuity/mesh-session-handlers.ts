// Gate-mode mesh sessions: run the whole request and answer its sender.
import type { MeshSource } from "./activation-store";
import type { MeshFailureInput, MeshSessionInput } from "./mesh-activation-runtime";
import type { ChannelHandler } from "../channels/types";

export const NO_ANSWER = "(the agent finished without an answer)";

/** The agent's side of one A2A conversation. Mesh forwards `replied` to the sender. */
export interface MeshConversationPort {
  /** True once the conversation has a `replied` event. */
  answered(conversationId: string): Promise<boolean>;
  /**
   * Reports only the steps still missing (`visible`, then `replied` with `content`). "already" when the
   * conversation was answered before, "fenced" when `fence` was aborted before `replied` could be sent.
   */
  finish(conversationId: string, content: string, fence: AbortSignal): Promise<"replied" | "already" | "fenced">;
}

export interface MeshSessionHandlerDeps {
  runTurn(agentId: string, message: string, channelId: string, signal: AbortSignal): Promise<string>;
  /** The agent's own conversations: each agent answers with its own registration credential. */
  conversation(agentId: string): MeshConversationPort;
  markReplied(agentId: string, sourceRef: string): void;
}

/** The shared adapter used by the server and the cancellation integration test. */
export function createMeshChannelTurn(channels: ReadonlyMap<string, ChannelHandler>): MeshSessionHandlerDeps["runTurn"] {
  return async (agentId, message, channelId, signal) => {
    const channel = channels.get(agentId);
    if (!channel) throw new Error(`no mesh session channel for ${agentId}`);
    return (await channel.handleMessage({ agentName: agentId, message, channelId, signal })).text;
  };
}

/** Only requests that came through the A2A inbox have a conversation to answer; legacy `mesh:` rows have none. */
function conversationOf(source: MeshSource | undefined): string | null {
  return source && source.sourceRef.startsWith("a2a:") && source.threadId ? source.threadId : null;
}

const NEVER = new AbortController().signal;

/** Same text the non-gate path hands an agent. */
export function formatMeshRequest(source: MeshSource): string {
  return `[mesh from ${source.fromId}] ${source.subject ? `[${source.subject}] ` : ""}${source.content}`;
}

export function createMeshSessionHandlers(deps: MeshSessionHandlerDeps) {
  // One finisher per request: an answer still being reported and the final-failure notice never interleave.
  const finishing = new Map<string, Promise<unknown>>();
  const serialized = <T>(sourceRef: string, work: () => Promise<T>): Promise<T> => {
    const previous = finishing.get(sourceRef) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    finishing.set(sourceRef, current);
    void current.catch(() => {}).finally(() => { if (finishing.get(sourceRef) === current) finishing.delete(sourceRef); });
    return current;
  };

  return {
    async executeSession({ candidate, grant, source, signal }: MeshSessionInput): Promise<string> {
      const { agentId, sourceRef } = candidate;
      if (source?.repliedAt) return `mesh-session:${sourceRef}:replayed`;
      const conversationId = conversationOf(source);
      // Mesh may hold the answer even when this store does not (a crash after replied, before markReplied).
      if (conversationId && await deps.conversation(agentId).answered(conversationId)) {
        deps.markReplied(agentId, sourceRef);
        return `mesh-session:${sourceRef}:replayed`;
      }
      if (signal.aborted) return `mesh-session:${sourceRef}:late`;
      const text = await deps.runTurn(agentId, source ? formatMeshRequest(source) : candidate.summary, `mesh:${grant.leaseId}`, signal);
      if (signal.aborted) return `mesh-session:${sourceRef}:late`;
      if (conversationId) {
        const outcome = await serialized(sourceRef, () => deps.conversation(agentId).finish(conversationId, text.length > 0 ? text : NO_ANSWER, signal));
        if (outcome === "fenced") return `mesh-session:${sourceRef}:late`;
        deps.markReplied(agentId, sourceRef);
      }
      return `mesh-session:${sourceRef}:${text.length}`;
    },

    async onFailed({ candidate, source, error, attempts, final, timedOut }: MeshFailureInput): Promise<void> {
      const conversationId = conversationOf(source);
      if (!final || !source || !conversationId) return;
      const reason = timedOut
        ? `timed out (${error instanceof Error ? error.message : String(error)})`
        : error instanceof Error ? error.message : String(error);
      const request = source.subject || source.content.slice(0, 120) || candidate.summary;
      const content = `Request "${request}" failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${reason}`;
      // finish() re-reads the conversation: when a late answer already committed, the notice is not sent.
      await serialized(source.sourceRef, () => deps.conversation(candidate.agentId).finish(conversationId, content, NEVER));
      deps.markReplied(candidate.agentId, source.sourceRef);
    },
  };
}
