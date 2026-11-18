import type { GardenEvent } from "./events";

export interface BuildOperationalBriefOptions {
  goal: string;
  agentId: string;
  project: string;
  events: GardenEvent[];
  memoryRecall?: string[];
  priorJudgments?: string[];
}

export interface OperationalBrief {
  goal: string;
  currentMission: string;
  knownState: string[];
  openThreads: string[];
  blockers: string[];
  recentEvidence: string[];
  priorJudgments: string[];
  failurePatterns: string[];
  nextBestMove: string;
  substrateMutation: false;
  identityMutation: false;
  memoryMutation: false;
}

export function buildOperationalBrief(options: BuildOperationalBriefOptions): OperationalBrief {
  const relevantEvents = options.events.filter((event) => {
    return event.project === options.project && event.agentId === options.agentId;
  });
  const blockers = relevantEvents
    .filter((event) => event.type === "BLOCKER_REPORTED")
    .map((event) => readPayloadText(event, "blocker"))
    .filter(Boolean);
  const recentEvidence = relevantEvents.flatMap((event) => {
    const fromEvidence = (event.evidence ?? []).map((item) => {
      const exit = item.exitCode === undefined ? "" : ` exit=${item.exitCode}`;
      return `${item.kind}:${item.ref}${exit}${item.summary ? ` - ${item.summary}` : ""}`;
    });
    const command = readPayloadText(event, "command");
    return command ? [...fromEvidence, command] : fromEvidence;
  });
  const knownState = relevantEvents.map((event) => describeEvent(event)).filter(Boolean);
  const failurePatterns = blockers.length > 0
    ? [...new Set(blockers.map((blocker) => `recent blocker: ${blocker}`))]
    : [];

  return {
    goal: options.goal,
    currentMission: `${options.agentId} on ${options.project}: ${options.goal}`,
    knownState: [...knownState, ...(options.memoryRecall ?? []).map((item) => `memory: ${item}`)],
    openThreads: relevantEvents
      .filter((event) => event.type === "TASK_STARTED")
      .map((event) => readPayloadText(event, "goal"))
      .filter(Boolean),
    blockers,
    recentEvidence,
    priorJudgments: options.priorJudgments ?? [],
    failurePatterns,
    nextBestMove: blockers.length > 0
      ? `resolve blocker: ${blockers[0]}`
      : relevantEvents.length === 0
        ? "start with a failing test or direct inspection"
        : "continue with the next planned verification step",
    substrateMutation: false,
    identityMutation: false,
    memoryMutation: false,
  };
}

function describeEvent(event: GardenEvent): string {
  const goal = readPayloadText(event, "goal");
  const command = readPayloadText(event, "command");
  const blocker = readPayloadText(event, "blocker");
  const summary = goal || command || blocker;
  return summary ? `${event.type}: ${summary}` : event.type;
}

export function readPayloadText(event: GardenEvent, key: string): string {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || !(key in payload)) return "";
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : value === undefined ? "" : String(value);
}
