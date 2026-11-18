// ---------------------------------------------------------------------------
// Agora — inter-agent event bus types
// ---------------------------------------------------------------------------

import type { TrustDomain } from "../evaluation/trust-system";

// ── Event types ──────────────────────────────────────────────────────────────

export type AgoraEventType =
  | "task_complete"
  | "task_failed"
  | "task_blocked"
  | "agent_offline"
  | "agent_online"
  | "task_assigned";

// ── Legio types ──────────────────────────────────────────────────────────────

export type LegioType = "codex" | "qwen" | "gemini";

export interface LegioDescriptor {
  /** Unique legio agent id (e.g. "codex-1", "qwen-2") */
  id: string;
  /** Legio type (determines routing domain) */
  type: LegioType;
  /** Human-readable label */
  label: string;
  /** Whether the legio is currently accepting tasks */
  available: boolean;
  /** Current trust score for the relevant domain */
  trustScore: number;
  /** Estimated cost per task (arbitrary unit, lower = cheaper) */
  cost: number;
  /** Active task count */
  activeTasks: number;
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface AgoraTaskCompleteEvent {
  type: "task_complete";
  taskId: string;
  agentId: string;
  domain: TrustDomain;
  result: string;
  timestamp: string;
}

export interface AgoraTaskFailedEvent {
  type: "task_failed";
  taskId: string;
  agentId: string;
  domain: TrustDomain;
  error: string;
  timestamp: string;
}

export interface AgoraTaskBlockedEvent {
  type: "task_blocked";
  taskId: string;
  agentId: string;
  domain: TrustDomain;
  reason: string;
  timestamp: string;
}

export interface AgoraAgentOfflineEvent {
  type: "agent_offline";
  agentId: string;
  legioType: LegioType;
  timestamp: string;
}

export interface AgoraAgentOnlineEvent {
  type: "agent_online";
  agentId: string;
  legioType: LegioType;
  timestamp: string;
}

export interface AgoraTaskAssignedEvent {
  type: "task_assigned";
  taskId: string;
  agentId: string;
  legioId: string;
  domain: TrustDomain;
  timestamp: string;
}

export type AgoraEvent =
  | AgoraTaskCompleteEvent
  | AgoraTaskFailedEvent
  | AgoraTaskBlockedEvent
  | AgoraAgentOfflineEvent
  | AgoraAgentOnlineEvent
  | AgoraTaskAssignedEvent;

// ── Options ──────────────────────────────────────────────────────────────────

export interface AgoraClientOptions {
  roomsDir?: string;
  /** Telegram chat IDs to notify for blocked tasks */
  notifyChatIds?: string[];
  /** Evaluation pipeline for gating completed task results */
  evaluationPipeline?: import("../evaluation/pipeline").EvaluationPipeline;
  log?: (level: "info" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

export interface RequestLegioOptions {
  priority?: number;
  cartridges?: string[];
}

// ── Event handler ────────────────────────────────────────────────────────────

export type AgoraEventHandler = (event: AgoraEvent) => void | Promise<void>;

// ── Legio routing config ─────────────────────────────────────────────────────

export const LEGIO_ROUTING: Record<LegioType, { label: string; description: string }> = {
  codex: { label: "Codex", description: "code implementation, precise edits, token-heavy tasks" },
  qwen: { label: "Qwen", description: "parallel tasks, quota-tight execution, cheap inference" },
  gemini: { label: "Gemini", description: "analysis, research, review, creative work" },
};

/**
 * Map a task domain to the preferred legio type.
 * Code → Codex, Parallel/quota-tight → Qwen, Analysis → Gemini.
 * Can be overridden via config.
 */
export function defaultLegioForDomain(domain: TrustDomain): LegioType {
  switch (domain) {
    case "code_review":
      return "codex";
    case "external_action":
      return "qwen";
    case "memory_write":
      return "qwen";
    case "architecture":
      return "gemini";
    case "communication":
      return "gemini";
    case "private_mode":
      return "gemini";
  }
}
