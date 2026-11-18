/**
 * rfcclub/anima#103: what the server does with one item from a hosted agent's A2A inbox. A throw keeps
 * the inbox cursor, so the item is offered again.
 *
 * - gate/enforce: durable ingress into the activation store, then a broker dispatch (#100 rules).
 * - off/shadow: the item is kept in `mesh_sources` first, as in gate mode; a forwarded reply stops
 *   there (never answered, AJ-10); a request runs inline and is answered on its conversation.
 * - a colony-mesh job notice to an agent this server's job consumer works as runs no turn in either
 *   mode: it is kept and answered, and the consumer's claim turn is the job's only turn.
 */
import { a2aSourceInput, type A2AInboxRequest, type MeshIngressOutcome } from "../continuity/mesh-ingress";
import type { MeshSourceInput } from "../continuity/activation-store";
import { NO_ANSWER, type MeshConversationPort } from "../continuity/mesh-session-handlers";

export interface InboxDeliveryDeps {
  /** The gate-mode runtime, or null outside gate/enforce. */
  activation: {
    ingestA2A(agentId: string, request: A2AInboxRequest): MeshIngressOutcome;
    dispatch(agentId: string, sourceRef: string): Promise<unknown>;
  } | null;
  /** Keeps an item outside gate mode (`mesh_sources`). */
  retain(source: MeshSourceInput): void;
  runTurn(agentId: string, message: string): Promise<string>;
  conversation(agentId: string): MeshConversationPort;
  now(): number;
  log: (level: "info" | "error", message: string, fields: Record<string, unknown>) => void;
  /** True when this server's mesh job consumer works as the agent; absent means no worker. */
  jobWorker?(agentId: string): boolean;
}

/** The notice `mesh review` sends each candidate; returns the job ID, or null for any other text. */
export function jobNoticeId(body: string): string | null {
  const match = /^Review job ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}): [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+ at [0-9a-f]{40}\.\nTake it with: [^\n]+ jobs claim\n/.exec(body);
  return match ? match[1]! : null;
}

export function createInboxDelivery(deps: InboxDeliveryDeps) {
  return async (agentId: string, request: A2AInboxRequest): Promise<void> => {
    deps.log("info", "mesh message received", { type: "mesh_inbox", agent: agentId, from: request.sender, reply: Boolean(request.replyTo) });
    const jobId = request.replyTo ? null : jobNoticeId(request.body);
    if (jobId && deps.jobWorker?.(agentId)) {
      deps.retain(a2aSourceInput(agentId, request, deps.now()));
      deps.log("info", "mesh job notice left to the job consumer", { agent: agentId, jobId });
      await deps.conversation(agentId).finish(request.conversationId,
        `Job ${jobId} is left to this agent's mesh job consumer, which claims it.`, new AbortController().signal);
      return;
    }
    const activation = deps.activation;
    if (activation) {
      const outcome = activation.ingestA2A(agentId, request);
      if (outcome.disposition === "retry") throw new Error("mesh ingress could not store the request");
      if (outcome.route === "candidate") {
        const sourceRef = `a2a:${request.conversationId}`;
        queueMicrotask(() => {
          activation.dispatch(agentId, sourceRef).catch((error) => deps.log("error", "broker mesh-session execution failed", {
            agent: agentId, sourceRef, error: error instanceof Error ? error.message : String(error),
          }));
        });
      }
      return;
    }
    deps.retain(a2aSourceInput(agentId, request, deps.now()));
    if (request.replyTo) return;
    const text = await deps.runTurn(agentId, `[mesh from ${request.sender}] ${request.body}`);
    deps.log("info", "mesh agent responded", { agent: agentId, replyLength: text.length });
    await deps.conversation(agentId).finish(request.conversationId, text || NO_ANSWER, new AbortController().signal);
  };
}
