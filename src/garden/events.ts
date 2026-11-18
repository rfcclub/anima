export type GardenEventType =
  | "TASK_STARTED"
  | "TOOL_CALLED"
  | "TEST_RUN"
  | "VERIFY_RESULT"
  | "BLOCKER_REPORTED"
  | "HANDOFF_WRITTEN"
  | "MEMORY_PROPOSAL"
  | "TICK_ACTION"
  | "AUTONOMY_CHANGE"
  | "AGENT_MOVED"
  | "MEETING_CONVENED"
  | "MEETING_JOINED"
  | "MEETING_TURN"
  | "MEETING_CLOSED"
  | "ENCOUNTER"
  | "ENCOUNTER_LINE"
  | "SHARED_CONVERSATION_TURN"
  | "EXPEDITION_CLAIMED"
  | "EXPEDITION_ENDED"
  | "DISCOVERY"
  | "ATTENTION_OPENED"
  | "ATTENTION_STATE_CHANGED"
  | "ACTIVATION_SUPPRESSED"
  | "ACTIVATION_LEASED"
  | "ACTIVATION_COMPLETED"
  | "ACTIVATION_RELEASED"
  | "PULSE_STAGE_STARTED"
  | "PULSE_STAGE_COMPLETED";

export type GardenRuntime = "cli" | "daemon" | "hub" | "mesh" | "test";
export type GardenConfidence = "low" | "medium" | "high";

export interface GardenEvidence {
  kind: "command" | "file" | "test" | "log" | "observation";
  ref: string;
  summary?: string;
  exitCode?: number;
}

export interface GardenEvent<TPayload = unknown> {
  id: string;
  type: GardenEventType;
  timestamp: string;
  agentId: string;
  instanceId: string;
  runtime: GardenRuntime;
  project: string;
  payload: TPayload;
  evidence?: GardenEvidence[];
  confidence?: GardenConfidence;
}

export type GardenEventInput<TPayload = unknown> = GardenEvent<TPayload>;

const EVENT_TYPES = new Set<GardenEventType>([
  "TASK_STARTED",
  "TOOL_CALLED",
  "TEST_RUN",
  "VERIFY_RESULT",
  "BLOCKER_REPORTED",
  "HANDOFF_WRITTEN",
  "MEMORY_PROPOSAL",
  "TICK_ACTION",
  "AUTONOMY_CHANGE",
  "AGENT_MOVED",
  "MEETING_CONVENED",
  "MEETING_JOINED",
  "MEETING_TURN",
  "MEETING_CLOSED",
  "ENCOUNTER",
  "ENCOUNTER_LINE",
  "SHARED_CONVERSATION_TURN",
  "EXPEDITION_CLAIMED",
  "EXPEDITION_ENDED",
  "DISCOVERY",
  "ATTENTION_OPENED",
  "ATTENTION_STATE_CHANGED",
  "ACTIVATION_SUPPRESSED",
  "ACTIVATION_LEASED",
  "ACTIVATION_COMPLETED",
  "ACTIVATION_RELEASED",
  "PULSE_STAGE_STARTED",
  "PULSE_STAGE_COMPLETED",
]);

const RUNTIMES = new Set<GardenRuntime>(["cli", "daemon", "hub", "mesh", "test"]);

export function createGardenEvent<TPayload>(input: GardenEventInput<TPayload>): GardenEvent<TPayload> {
  validateGardenEvent(input);
  return {
    ...input,
    evidence: input.evidence ? [...input.evidence] : undefined,
  };
}

export function validateGardenEvent(event: GardenEvent): void {
  requireString(event.id, "id");
  if (!EVENT_TYPES.has(event.type)) {
    throw new Error(`invalid Garden event type: ${String(event.type)}`);
  }
  requireString(event.timestamp, "timestamp");
  if (Number.isNaN(Date.parse(event.timestamp))) {
    throw new Error("timestamp must be an ISO-parseable string");
  }
  requireString(event.agentId, "agentId");
  requireString(event.instanceId, "instanceId");
  if (!RUNTIMES.has(event.runtime)) {
    throw new Error(`invalid runtime: ${String(event.runtime)}`);
  }
  requireString(event.project, "project");
  if (!("payload" in event)) {
    throw new Error("payload is required");
  }
  if (event.type === "AGENT_MOVED") {
    validateAgentMovedPayload(event.payload);
  }
  if (event.type === "ATTENTION_OPENED" || event.type === "ATTENTION_STATE_CHANGED") {
    validateAttentionPayload(event.payload);
  }
  if (event.type.startsWith("ACTIVATION_")) {
    validateActivationPayload(event.type as Extract<GardenEventType, `ACTIVATION_${string}`>, event.payload);
  }
  if (event.evidence) {
    for (const [index, item] of event.evidence.entries()) {
      requireString(item.kind, `evidence[${index}].kind`);
      requireString(item.ref, `evidence[${index}].ref`);
    }
  }
}

function validateActivationPayload(type: Extract<GardenEventType, `ACTIVATION_${string}`>, payload: unknown): void {
  if (!payload || typeof payload !== "object") throw new Error("activation payload must be an object");
  const p = payload as Record<string, unknown>;
  requireString(p.candidateKey, "activation payload.candidateKey");
  requireString(p.sourceRef, "activation payload.sourceRef");
  requireString(p.reasonRef, "activation payload.reasonRef");
  requireString(p.occurrenceKey, "activation payload.occurrenceKey");
  if (type !== "ACTIVATION_SUPPRESSED") requireString(p.leaseId, "activation payload.leaseId");
  if (type === "ACTIVATION_SUPPRESSED") requireString(p.reason, "activation payload.reason");
  if (type === "ACTIVATION_LEASED" && (!Number.isInteger(p.costUnits) || (p.costUnits as number) < 0)) {
    throw new Error("activation payload.costUnits must be a non-negative integer");
  }
  if (type === "ACTIVATION_COMPLETED") {
    if (!Number.isInteger(p.settledUnits) || (p.settledUnits as number) < 0) {
      throw new Error("activation payload.settledUnits must be a non-negative integer");
    }
    if (!Array.isArray(p.producedEventIds) || p.producedEventIds.length === 0 || p.producedEventIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("activation payload.producedEventIds must be non-empty strings");
    }
  }
}

function validateAttentionPayload(payload: unknown): void {
  if (!payload || typeof payload !== "object") {
    throw new Error("attention payload must be an object");
  }
  const p = payload as Record<string, unknown>;
  requireString(p.sourceKind, "attention payload.sourceKind");
  requireString(p.sourceRef, "attention payload.sourceRef");
  requireString(p.occurrenceKey, "attention payload.occurrenceKey");
  requireString(p.state, "attention payload.state");
  if (typeof p.version !== "number" || !Number.isInteger(p.version) || p.version < 1) {
    throw new Error("attention payload.version must be a positive integer");
  }
  if (typeof p.occurredAt !== "number" || !Number.isFinite(p.occurredAt)) {
    throw new Error("attention payload.occurredAt must be a number");
  }
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
}

interface AgentMovedPayload {
  from: string;
  to: string;
  disposition: string;
  seed: number;
}

function validateAgentMovedPayload(payload: unknown): asserts payload is AgentMovedPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("AGENT_MOVED payload must be an object");
  }
  const p = payload as Record<string, unknown>;
  requireString(p.from, "AGENT_MOVED payload.from");
  requireString(p.to, "AGENT_MOVED payload.to");
  requireString(p.disposition, "AGENT_MOVED payload.disposition");
  if (!["wander", "home", "seek"].includes(p.disposition as string)) {
    throw new Error(`AGENT_MOVED payload.disposition must be wander|home|seek, got: ${String(p.disposition)}`);
  }
  if (typeof p.seed !== "number" || !Number.isFinite(p.seed)) {
    throw new Error("AGENT_MOVED payload.seed must be a number");
  }
}
