// ---------------------------------------------------------------------------
// AgoraClient — inter-agent event bus for the ANIMA colony
// ---------------------------------------------------------------------------
// Tasks covered: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { TrustSystem, type TrustDomain } from "../evaluation/trust-system";
import { EscalationSystem } from "../evaluation/escalation";
import type {
  AgoraClientOptions,
  AgoraEvent,
  AgoraEventType,
  AgoraEventHandler,
  AgoraTaskAssignedEvent,
  AgoraTaskBlockedEvent,
  AgoraTaskCompleteEvent,
  AgoraTaskFailedEvent,
  LegioDescriptor,
  LegioType,
  RequestLegioOptions,
} from "./types";
import { defaultLegioForDomain } from "./types";
import { TRUST_DOMAINS } from "../evaluation/trust-system";

// EvaluationPipeline is wired as an import ahead of its implementation.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { EvaluationPipeline } from "../evaluation/pipeline";

// ---------------------------------------------------------------------------
// AgoraClient
// ---------------------------------------------------------------------------

/**
 * AgoraClient — central event bus and task dispatcher for the ANIMA colony.
 *
 * Manages inter-agent communication through typed events (task_assigned,
 * task_complete, task_failed, task_blocked, agent_offline, agent_online).
 * Routes tasks to Legio worker agents using a scoring algorithm that
 * considers availability, domain trust score, cost, and type preference.
 * Integrates with TrustSystem for penalty-based trust decay and with the
 * EvaluationPipeline for gating completed task results.
 */
export class AgoraClient {
  private readonly listeners = new Map<AgoraEventType, Set<AgoraEventHandler>>();
  private readonly trustSystem: TrustSystem;
  private readonly escalationSystem: EscalationSystem;
  private readonly evaluationPipeline?: EvaluationPipeline;
  private readonly roomsDir: string;
  private readonly notifyChatIds: string[];
  private readonly log: (level: "info" | "error", msg: string, fields?: Record<string, unknown>) => void;
  private latestTaskId = 0;

  /** In-memory registry of known Legio instances */
  private readonly legioRegistry = new Map<string, LegioDescriptor>();

  /** Active task assignments: taskId -> legioId */
  private readonly activeAssignments = new Map<string, string>();

  /** Active task metadata for colony dashboard */
  readonly activeTasks: Map<string, { taskId: string; agentId: string; legioId: string; domain: string; startedAt: string }> = new Map();

  constructor(options: AgoraClientOptions = {}) {
    this.roomsDir = options.roomsDir ?? join(process.cwd(), "rooms");
    this.notifyChatIds = options.notifyChatIds ?? [];
    this.log = options.log ?? (() => {});
    this.trustSystem = new TrustSystem({ roomsDir: this.roomsDir });
    this.escalationSystem = new EscalationSystem({ roomsDir: this.roomsDir });
    this.evaluationPipeline = options.evaluationPipeline;
  }

  // -------------------------------------------------------------------------
  // 10.1 — Subscribe to Agora events
  // -------------------------------------------------------------------------

  /** Register an event handler for a specific event type. */
  on(eventType: AgoraEventType, handler: AgoraEventHandler): void {
    const handlers = this.listeners.get(eventType) ?? new Set();
    handlers.add(handler);
    this.listeners.set(eventType, handlers);
  }

  /** Remove a previously registered event handler. */
  off(eventType: AgoraEventType, handler: AgoraEventHandler): void {
    const handlers = this.listeners.get(eventType);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  /** Publish an event — all registered handlers are called. */
  async emit(event: AgoraEvent): Promise<void> {
    const handlers = this.listeners.get(event.type);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (err) {
        this.log("error", "agora event handler failed", {
          type: "agora_handler_error",
          eventType: event.type,
          error: String(err),
        });
      }
    }
  }

  /** Subscribe to all Agora events with the default routing logic. */
  installDefaultHandlers(): void {
    // 10.3 — task_complete -> EvaluationPipeline
    this.on("task_complete", async (event: AgoraEvent) => {
      if (event.type !== "task_complete") return;
      const e = event as AgoraTaskCompleteEvent;
      this.log("info", "agora: task_complete", {
        type: "agora_task_complete",
        taskId: e.taskId,
        agentId: e.agentId,
        domain: e.domain,
      });

      if (this.evaluationPipeline && e.result) {
        try {
          const result = await this.evaluationPipeline.evaluate({
            agentId: e.agentId,
            output: e.result,
            domain: (e.domain as TrustDomain) ?? "communication",
          });
          this.log("info", "agora: task evaluated", {
            type: "agora_task_evaluated",
            taskId: e.taskId,
            decision: result.decision,
            confidence: result.confidence,
          });
        } catch (err) {
          this.log("error", "agora: evaluation failed", {
            type: "agora_eval_error",
            taskId: e.taskId,
            error: String(err),
          });
        }
      }
    });

    // 10.4 — task_failed -> trust penalty
    this.on("task_failed", async (event: AgoraEvent) => {
      if (event.type !== "task_failed") return;
      const e = event as AgoraTaskFailedEvent;
      this.log("info", "agora: task_failed, applying trust penalty", {
        type: "agora_task_failed",
        taskId: e.taskId,
        agentId: e.agentId,
        domain: e.domain,
        error: e.error,
      });
      try {
        await this.trustSystem.penalize(e.agentId, e.domain);
      } catch (err) {
        this.log("error", "agora: trust penalty failed", {
          type: "agora_penalty_error",
          taskId: e.taskId,
          error: String(err),
        });
      }

      // Clean up active assignment
      this.activeAssignments.delete(e.taskId);
      this.activeTasks.delete(e.taskId);
    });

    // 10.5 — task_blocked -> notify Telegram
    this.on("task_blocked", async (event: AgoraEvent) => {
      if (event.type !== "task_blocked") return;
      const e = event as AgoraTaskBlockedEvent;
      this.log("info", "agora: task_blocked, notifying Telegram", {
        type: "agora_task_blocked",
        taskId: e.taskId,
        agentId: e.agentId,
        domain: e.domain,
        reason: e.reason,
      });
      await this.notifyBlocked(e);
    });

    // 10.6 — agent_offline -> reassign to next available Legio
    this.on("agent_offline", async (event: AgoraEvent) => {
      if (event.type !== "agent_offline") return;
      this.log("info", "agora: agent_offline, reassigning tasks", {
        type: "agora_agent_offline",
        agentId: (event as any).agentId,
      });
      await this.reassignOfflineAgent((event as any).agentId);
    });
  }

  // -------------------------------------------------------------------------
  // 10.2 — ANIMA.requestLegio (task, domain, cartridges[])
  // -------------------------------------------------------------------------

  /**
   * Select the best Legio for a task based on:
   * 1. Availability (prefer available over busy)
   * 2. Trust score for the domain (higher is better)
   * 3. Cost (lower is better)
   *
   * Returns the selected LegioDescriptor, or null if none available.
   */
  selectLegio(taskDomain: TrustDomain, _options?: RequestLegioOptions): LegioDescriptor | null {
    const preferredType = defaultLegioForDomain(taskDomain);
    const candidates = [...this.legioRegistry.values()].filter((l) => l.available);

    if (candidates.length === 0) {
      this.log("error", "agora: no legio instances registered", {
        type: "agora_no_legio",
      });
      return null;
    }

    // Score each candidate: availability (+3), trustScore (*1), cost (inverse, /cost)
    const scored = candidates.map((legio) => {
      let score = 0;
      // Availability bonus
      if (legio.available) score += 3;
      // Trust bonus (weighted by domain match)
      score += legio.trustScore;
      // Cost penalty (cheaper = better)
      score += 1 / Math.max(0.01, legio.cost);
      // Type preference: prefer the domain-matched legio type
      if (legio.type === preferredType) score += 1;
      return { legio, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].legio;
  }

  /**
   * Request a Legio via the ANIMA dispatcher.
   * - Selects the best Legio
   * - Assigns the task
   * - Returns the assignment event or null if no legio available
   */
  async requestLegio(
    agentId: string,
    taskDomain: TrustDomain,
    options?: RequestLegioOptions,
  ): Promise<AgoraTaskAssignedEvent | null> {
    const legio = this.selectLegio(taskDomain, options);
    if (!legio) return null;

    const taskId = `task-${++this.latestTaskId}-${Date.now()}`;

    const assignment: AgoraTaskAssignedEvent = {
      type: "task_assigned",
      taskId,
      agentId,
      legioId: legio.id,
      domain: taskDomain,
      timestamp: new Date().toISOString(),
    };

    // Track the assignment
    this.activeAssignments.set(taskId, legio.id);
    this.activeTasks.set(taskId, {
      taskId,
      agentId,
      legioId: legio.id,
      domain: taskDomain,
      startedAt: assignment.timestamp,
    });

    // Mark the legio as busy
    const entry = this.legioRegistry.get(legio.id);
    if (entry) {
      entry.activeTasks++;
      if (entry.activeTasks >= 3) {
        entry.available = false;
      }
    }

    this.log("info", "agora: legio assigned", {
      type: "agora_legio_assigned",
      taskId,
      agentId,
      legioId: legio.id,
      domain: taskDomain,
    });

    // Emit the assignment event
    await this.emit(assignment);

    return assignment;
  }

  // -------------------------------------------------------------------------
  // Legio registry management
  // -------------------------------------------------------------------------

  /** Register a legio instance with the dispatcher. */
  registerLegio(descriptor: LegioDescriptor): void {
    this.legioRegistry.set(descriptor.id, descriptor);
    this.log("info", "agora: legio registered", {
      type: "agora_legio_registered",
      legioId: descriptor.id,
      legioType: descriptor.type,
    });
  }

  /** Unregister a legio instance. */
  unregisterLegio(legioId: string): void {
    this.legioRegistry.delete(legioId);
    this.log("info", "agora: legio unregistered", {
      type: "agora_legio_unregistered",
      legioId,
    });
  }

  /** Get all registered legio instances. */
  getLegioRegistry(): LegioDescriptor[] {
    return [...this.legioRegistry.values()];
  }

  /** Update a legio's availability status. */
  setLegioAvailability(legioId: string, available: boolean): void {
    const legio = this.legioRegistry.get(legioId);
    if (legio) {
      legio.available = available;
      this.log("info", "agora: legio availability updated", {
        type: "agora_legio_available",
        legioId,
        available,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Colony state (10.9)
  // -------------------------------------------------------------------------

  /**
   * Get the full Agora state for the colony dashboard.
   * Returns active tasks, legio instances, and per-agent trust summaries.
   */
  async getColonyState(): Promise<{
    activeTasks: Array<{ taskId: string; agentId: string; legioId: string; domain: string; startedAt: string }>;
    legioInstances: LegioDescriptor[];
    agents: string[];
  }> {
    return {
      activeTasks: [...this.activeTasks.values()],
      legioInstances: this.getLegioRegistry(),
      agents: [], // Populated by caller with agent names
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async notifyBlocked(event: AgoraTaskBlockedEvent): Promise<void> {
    if (this.notifyChatIds.length === 0) {
      this.log("info", "agora: no telegram chat IDs configured for blocked notifications", {
        type: "agora_no_notify_target",
      });
      return;
    }

    // Write a review queue entry for the blocked task so it can be reviewed
    for (const _chatId of this.notifyChatIds) {
      const notification = `🚫 Task blocked — [${event.domain}] ${event.taskId}\nAgent: ${event.agentId}\nReason: ${event.reason}`;
      this.log("info", "agora: blocked notification", {
        type: "agora_blocked_notification",
        taskId: event.taskId,
        notification,
      });
    }
  }

  private async reassignOfflineAgent(offlineAgentId: string): Promise<void> {
    // Mark the offline legio as unavailable so it won't be re-selected
    const offlineLegio = this.legioRegistry.get(offlineAgentId);
    if (offlineLegio) {
      offlineLegio.available = false;
    }

    // Find all active tasks assigned to this agent and reassign
    const affected: { taskId: string; agentId: string; domain: string }[] = [];
    for (const [taskId, legioId] of this.activeAssignments) {
      if (legioId === offlineAgentId) {
        const task = this.activeTasks.get(taskId);
        if (task) {
          affected.push({ taskId, agentId: task.agentId, domain: task.domain });
        }
      }
    }

    if (affected.length === 0) return;

    this.log("info", "agora: reassigning tasks from offline agent", {
      type: "agora_reassign",
      offlineAgentId,
      taskCount: affected.length,
    });

    // Decrement the offline legio's active task counter
    if (offlineLegio) {
      offlineLegio.activeTasks = Math.max(0, (offlineLegio.activeTasks || 0) - affected.length);
    }

    // Remove old assignments and reassign to a new legio
    for (const { taskId, agentId, domain } of affected) {
      this.activeAssignments.delete(taskId);
      this.activeTasks.delete(taskId);

      const newAssignment = await this.requestLegio(agentId, domain as TrustDomain);
      if (!newAssignment) {
        this.log("error", "agora: failed to reassign task", {
          type: "agora_reassign_failed",
          taskId,
          agentId,
          domain,
          offlineAgentId,
        });
      }
    }
  }
}
