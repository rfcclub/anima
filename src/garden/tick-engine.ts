import { createGardenEvent } from "./events";
import type { JsonlGardenEventStore } from "./event-store";
import type { GardenHub, WorkTask } from "./hub";
import { runProgrammingLoop, type CommandResult } from "./programming-loop";

export interface ColonyBudget {
  dailyTokens: number;
  usedToday: number;
  remaining: number;
}

export interface TickReport {
  tasksDispatched: number;
  tasksCompleted: number;
  blockers: string[];
  budgetRemaining: number;
}

export interface TickEngineOptions {
  hub: GardenHub;
  store: JsonlGardenEventStore;
  interval: number;
  budget: { dailyTokens: number; usedToday?: number };
  runCommand: (command: string) => Promise<CommandResult>;
  costPerTask?: number;
  project?: string;
  now?: () => string;
  id?: () => string;
}

const DEFAULT_VERIFICATION = { command: "bun test" };

export class TickEngine {
  readonly hub: GardenHub;
  readonly store: JsonlGardenEventStore;
  readonly interval: number;

  private dailyTokens: number;
  private usedToday: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: TickEngineOptions) {
    this.hub = options.hub;
    this.store = options.store;
    this.interval = options.interval;
    this.dailyTokens = options.budget.dailyTokens;
    this.usedToday = options.budget.usedToday ?? 0;
  }

  get budget(): ColonyBudget {
    return {
      dailyTokens: this.dailyTokens,
      usedToday: this.usedToday,
      remaining: Math.max(0, this.dailyTokens - this.usedToday),
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.interval);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = {
      tasksDispatched: 0,
      tasksCompleted: 0,
      blockers: [],
      budgetRemaining: this.budget.remaining,
    };
    const costPerTask = this.options.costPerTask ?? 0;

    for (const agent of this.hub.listAgents()) {
      if (agent.state !== "idle") continue;
      if (this.budget.remaining <= 0) break;

      const task = this.hub.claimTask(agent.agentId);
      if (!task) continue;

      task.status = "executing";
      report.tasksDispatched += 1;
      this.usedToday += costPerTask;

      const result = await this.dispatch(agent.agentId, agent.instanceId, task);
      if (result.status === "DONE") {
        report.tasksCompleted += 1;
        await this.hub.reportResult(task.id, { status: "done", events: result.events });
      } else {
        if (result.blocker) report.blockers.push(result.blocker);
        await this.hub.reportResult(task.id, {
          status: "blocked",
          events: result.events,
          blocker: result.blocker,
        });
      }
    }

    report.budgetRemaining = this.budget.remaining;
    await this.emitTickAction(report);
    return report;
  }

  private async dispatch(agentId: string, instanceId: string, task: WorkTask) {
    return runProgrammingLoop({
      goal: task.goal,
      agentId,
      instanceId,
      project: task.project,
      runtime: "hub",
      store: this.store,
      verification: task.verification ?? DEFAULT_VERIFICATION,
      runCommand: this.options.runCommand,
      now: this.options.now,
      id: this.options.id,
    });
  }

  private async emitTickAction(report: TickReport): Promise<void> {
    const now = this.options.now ?? (() => new Date().toISOString());
    const nextId = this.options.id ?? (() => crypto.randomUUID());
    await this.store.append(createGardenEvent({
      id: nextId(),
      type: "TICK_ACTION",
      timestamp: now(),
      agentId: "garden-hub",
      instanceId: "garden-hub",
      runtime: "hub",
      project: this.options.project ?? "garden",
      payload: { ...report, blockers: [...report.blockers] },
      confidence: "high",
    }));
  }
}
