import { buildOperationalBrief, type OperationalBrief } from "./brief";
import { createGardenEvent, type GardenEvent, type GardenRuntime } from "./events";
import type { JsonlGardenEventStore } from "./event-store";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunProgrammingLoopOptions {
  goal: string;
  agentId: string;
  instanceId: string;
  project: string;
  runtime: GardenRuntime;
  store: JsonlGardenEventStore;
  verification: { command: string };
  requestedActions?: string[];
  runCommand: (command: string) => Promise<CommandResult>;
  now?: () => string;
  id?: () => string;
}

export interface ProgrammingLoopResult {
  status: "DONE" | "BLOCKED";
  brief: OperationalBrief;
  events: GardenEvent[];
  evidence?: GardenEvent["evidence"];
  blocker?: string;
}

const APPROVAL_ACTIONS = new Set([
  "deploy",
  "release",
  "durable-substrate-write",
  "identity-change",
  "unbounded-retry",
  "production-mutation",
]);

export async function runProgrammingLoop(options: RunProgrammingLoopOptions): Promise<ProgrammingLoopResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const nextId = options.id ?? (() => crypto.randomUUID());
  const events: GardenEvent[] = [];

  const append = async (event: GardenEvent) => {
    await options.store.append(event);
    events.push(event);
  };

  const taskStarted = event(options, nextId, now, "TASK_STARTED", { goal: options.goal });
  await append(taskStarted);

  const approvalAction = (options.requestedActions ?? []).find((action) => APPROVAL_ACTIONS.has(action));
  if (approvalAction) {
    const blocker = `action requires approval: ${approvalAction}`;
    await append(event(options, nextId, now, "BLOCKER_REPORTED", { blocker, requestedAction: approvalAction }));
    return {
      status: "BLOCKED",
      brief: buildOperationalBrief({
        goal: options.goal,
        agentId: options.agentId,
        project: options.project,
        events,
      }),
      events,
      blocker,
    };
  }

  const result = await options.runCommand(options.verification.command);
  const evidence = [{
    kind: "command" as const,
    ref: options.verification.command,
    summary: result.stdout || result.stderr,
    exitCode: result.exitCode,
  }];
  await append(event(options, nextId, now, "TEST_RUN", {
    command: options.verification.command,
    exitCode: result.exitCode,
  }, evidence));
  await append(event(options, nextId, now, "VERIFY_RESULT", {
    command: options.verification.command,
    status: result.exitCode === 0 ? "PASS" : "FAIL",
    stdout: result.stdout,
    stderr: result.stderr,
  }, evidence));

  if (result.exitCode !== 0) {
    const blocker = `verification failed: ${options.verification.command}`;
    await append(event(options, nextId, now, "BLOCKER_REPORTED", { blocker }, evidence));
    return {
      status: "BLOCKED",
      brief: buildOperationalBrief({
        goal: options.goal,
        agentId: options.agentId,
        project: options.project,
        events,
      }),
      events,
      evidence,
      blocker,
    };
  }

  await append(event(options, nextId, now, "HANDOFF_WRITTEN", {
    status: "DONE",
    summary: `verified: ${options.verification.command}`,
  }, evidence));

  return {
    status: "DONE",
    brief: buildOperationalBrief({
      goal: options.goal,
      agentId: options.agentId,
      project: options.project,
      events,
    }),
    events,
    evidence,
  };
}

function event(
  options: RunProgrammingLoopOptions,
  nextId: () => string,
  now: () => string,
  type: GardenEvent["type"],
  payload: unknown,
  evidence?: GardenEvent["evidence"],
): GardenEvent {
  return createGardenEvent({
    id: nextId(),
    type,
    timestamp: now(),
    agentId: options.agentId,
    instanceId: options.instanceId,
    runtime: options.runtime,
    project: options.project,
    payload,
    evidence,
    confidence: "high",
  });
}
