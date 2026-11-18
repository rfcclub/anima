import type { MeshDelivery } from "colony-mesh";
import type { AttentionInput, AttentionItem, MeshSourceInput } from "./activation-store";

export type MeshIngressRoute = "candidate" | "wake" | "informational";
export type MeshIngressOutcome = { disposition: "ack" | "retry"; route: MeshIngressRoute };

export interface MeshIngressOptions {
  project(input: AttentionInput): AttentionItem | void;
  /** Called only after durable projection succeeds, before this ingress reports ack. */
  projected?(item: AttentionItem, input: AttentionInput): void;
  wake(agentId: string, sourceRef: string): void;
  /** Keeps the whole request by sourceRef before projection. A throw makes the ingress report retry. */
  retain?(source: MeshSourceInput): void;
}

const TERMINAL_OR_INFORMATIONAL_ROLES = new Set(["result", "response", "reply", "finding", "synthesis"]);

export function classifyMeshDelivery(delivery: MeshDelivery): MeshIngressRoute {
  const { role, pattern, from_id, to_platform } = delivery.message;
  if (TERMINAL_OR_INFORMATIONAL_ROLES.has(role)) return "informational";
  if (role === "knock") return "wake";
  if (role === "request") return "candidate";
  if (role === "message" && pattern === "direct" && from_id !== delivery.recipient_id && to_platform === "anima") return "candidate";
  return "informational";
}

/** One item from an agent's A2A inbox, with its verified sender already parsed. */
export interface A2AInboxRequest {
  conversationId: string;
  sender: string;
  body: string;
  /** Set when Mesh forwarded an answer to this agent's own earlier conversation. */
  replyTo?: string;
}

/** The kept form of an inbox item: the whole body, the verified sender and the conversation. */
export function a2aSourceInput(agentId: string, request: A2AInboxRequest, now: number): MeshSourceInput {
  return {
    agentId, sourceRef: `a2a:${request.conversationId}`, fromId: request.sender, fromPlatform: "a2a", threadId: request.conversationId,
    subject: "", content: request.body, role: request.replyTo ? "reply" : "request", createdAt: now,
  };
}

/** Owns classification and durable projection; callers ack only its outcome. */
export class MeshIngress {
  constructor(private readonly options: MeshIngressOptions) {}

  ingest(agentId: string, delivery: MeshDelivery): MeshIngressOutcome {
    const route = classifyMeshDelivery(delivery);
    if (route === "informational") return { disposition: "ack", route };
    const sourceRef = `mesh:${delivery.message_id}`;
    try {
      if (route === "wake") {
        this.options.wake(agentId, sourceRef);
        return { disposition: "ack", route };
      }
      const message = delivery.message;
      this.options.retain?.({
        agentId, sourceRef, fromId: message.from_id, fromPlatform: message.from_platform ?? null,
        threadId: message.thread_id ?? null, subject: message.subject ?? "", content: message.content ?? "",
        role: message.role, createdAt: Date.parse(message.created_at),
      });
      const input: AttentionInput = {
        agentId,
        sourceKind: "mesh",
        sourceRef,
        occurrenceKey: sourceRef,
        kind: "request",
        urgency: 5,
        summary: message.subject || message.content.slice(0, 400) || "mesh request",
        openedAt: Date.parse(message.created_at),
        dueAt: Date.parse(message.created_at),
        lastEventId: sourceRef,
      };
      const item = this.options.project(input);
      if (item) this.options.projected?.(item, input);
      this.options.wake(agentId, sourceRef);
      return { disposition: "ack", route };
    } catch {
      return { disposition: "retry", route };
    }
  }

  /**
   * Keeps the whole request before the inbox cursor may move. `retry` means nothing durable happened and
   * the inbox must offer the item again. A forwarded reply is kept once and starts nothing (no reply loops).
   */
  ingestA2A(agentId: string, request: A2AInboxRequest, now: number): MeshIngressOutcome {
    const route: MeshIngressRoute = request.replyTo ? "informational" : "candidate";
    const sourceRef = `a2a:${request.conversationId}`;
    try {
      this.options.retain?.(a2aSourceInput(agentId, request, now));
      if (request.replyTo) return { disposition: "ack", route };
      const input: AttentionInput = {
        agentId,
        sourceKind: "mesh",
        sourceRef,
        occurrenceKey: sourceRef,
        kind: "request",
        urgency: 5,
        summary: request.body.slice(0, 400) || "mesh request",
        openedAt: now,
        dueAt: now,
        lastEventId: sourceRef,
      };
      const item = this.options.project(input);
      if (item) this.options.projected?.(item, input);
      this.options.wake(agentId, sourceRef);
      return { disposition: "ack", route };
    } catch {
      return { disposition: "retry", route };
    }
  }
}
