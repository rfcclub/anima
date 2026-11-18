import type { ActionClass, AutonomyLadder } from "./autonomy-ladder";
import type { GardenEvent, GardenRuntime } from "./events";
import { projectGardenState, type GardenProjection } from "./projection";

export interface AgentEntry {
  agentId: string;
  name: string;
  instanceId: string;
  runtime: GardenRuntime;
  capabilities: ActionClass[];
  state: "idle" | "busy" | "offline";
}

export interface WorkTask {
  id: string;
  goal: string;
  project: string;
  actionClass?: ActionClass;
  verification?: { command: string };
  assignedTo?: string;
  status: "pending" | "claimed" | "executing" | "done" | "blocked";
  events: GardenEvent[];
}

export interface TaskResult {
  status: "done" | "blocked";
  violation?: boolean;
  events?: GardenEvent[];
  blocker?: string;
}

export interface GardenHubOptions {
  autonomy: AutonomyLadder;
}

export class GardenHub {
  readonly registry = new Map<string, AgentEntry>();
  readonly autonomy: AutonomyLadder;
  readonly workQueue: WorkTask[] = [];

  constructor(options: GardenHubOptions) {
    this.autonomy = options.autonomy;
  }

  registerAgent(entry: AgentEntry): void {
    this.registry.set(entry.agentId, { ...entry, capabilities: [...entry.capabilities] });
  }

  listAgents(): AgentEntry[] {
    return [...this.registry.values()];
  }

  enqueueTask(task: WorkTask): void {
    this.workQueue.push({ ...task, events: [...task.events] });
  }

  claimTask(agentId: string): WorkTask | null {
    const agent = this.registry.get(agentId);
    if (!agent || agent.state !== "idle") return null;

    const task = this.workQueue.find((candidate) => {
      if (candidate.status !== "pending") return false;
      const actionClass = candidate.actionClass ?? "code-change";
      if (!agent.capabilities.includes(actionClass)) return false;
      return this.autonomy.isAllowed(agentId, actionClass);
    });
    if (!task) return null;

    task.status = "claimed";
    task.assignedTo = agentId;
    agent.state = "busy";
    return task;
  }

  async reportResult(taskId: string, result: TaskResult): Promise<void> {
    const task = this.workQueue.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`unknown task: ${taskId}`);
    }
    task.status = result.status;
    if (result.events) {
      task.events.push(...result.events);
    }

    const agentId = task.assignedTo;
    if (!agentId) return;
    const agent = this.registry.get(agentId);
    if (agent) agent.state = "idle";

    const actionClass = task.actionClass ?? "code-change";
    if (result.status === "done") {
      await this.autonomy.recordSuccess(agentId, actionClass);
    } else if (result.violation) {
      await this.autonomy.recordViolation(agentId, actionClass);
    }
  }

  getProjection(): GardenProjection {
    return projectGardenState(this.workQueue.flatMap((task) => task.events));
  }
}
