import type { GardenEvent } from "./events";
import { readPayloadText } from "./brief";

export interface GardenProjectionOptions {
  project?: string;
}

export interface GardenProjection {
  activeSessions: string[];
  recentWork: string[];
  blockers: string[];
  verificationResults: string[];
  memoryProposals: string[];
  nextActions: string[];
}

export function projectGardenState(events: GardenEvent[], options: GardenProjectionOptions = {}): GardenProjection {
  const scoped = options.project
    ? events.filter((event) => event.project === options.project)
    : [...events];

  return {
    activeSessions: unique(scoped.map((event) => event.instanceId)),
    recentWork: scoped
      .filter((event) => event.type === "TASK_STARTED")
      .map((event) => readPayloadText(event, "goal") || event.id),
    blockers: scoped
      .filter((event) => event.type === "BLOCKER_REPORTED")
      .map((event) => readPayloadText(event, "blocker"))
      .filter(Boolean),
    verificationResults: scoped
      .filter((event) => event.type === "VERIFY_RESULT")
      .map((event) => readPayloadText(event, "command") || JSON.stringify(event.payload)),
    memoryProposals: scoped
      .filter((event) => event.type === "MEMORY_PROPOSAL")
      .map((event) => readPayloadText(event, "proposal"))
      .filter(Boolean),
    nextActions: scoped
      .map((event) => readPayloadText(event, "nextAction"))
      .filter(Boolean),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
