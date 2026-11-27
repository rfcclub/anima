import type { AgentMemoryEntry } from "../../memory/contract.ts";
import type { RuntimeProjection } from "./runtime-projection.ts";
import type { ProjectionGrant } from "./projection-grant.ts";
import type { IdentityRuntimeRecallResponse } from "./scope-mapper.ts";

/** Client intent only. Composition mode and scope policy remain server-owned. */
export interface ActiveJoinIntent {
  identity: string;
  surfaceId: string;
  message: string;
  cartridgeOverride?: string | null;
  hostContext?: string[];
}

/** ANIMA-to-Incarnation result; this is never the Windows-facing response. */
export interface RemoteCompileResult {
  projection: RuntimeProjection;
  grant: ProjectionGrant;
}

export interface RemoteRememberRequest {
  grantId: string;
  stateHash: string;
  idempotencyKey: string;
  entry: Omit<AgentMemoryEntry, "id" | "createdAt">;
}

/**
 * The continuity boundary refused a remember BEFORE touching the store, so
 * nothing landed. This is the only failure the runtime may treat as a proven
 * "not written" and use to release its pending mutation row; any other
 * failure is an unknown outcome and stays pending (mutation recovery).
 */
export class RememberRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RememberRejectedError";
  }
}

export interface RemoteRememberResult {
  id: string;
  createdAt: string;
}

export interface RemoteRecallRequest {
  grantId: string;
  stateHash: string;
  query: string;
  substrateScope: string;
}

export type RemoteRecallResult = IdentityRuntimeRecallResponse<AgentMemoryEntry>;

/** Free-text recall over the identity's own memory, for hosts that hold no store of their own. */
export interface RemoteDirectRecallRequest {
  grantId: string;
  stateHash: string;
  query: string;
}

export type RemoteDirectRecallResult = Array<{ source: string; content: string }>;

export interface RemoteRoomReadRequest {
  grantId: string;
  stateHash: string;
  placeId: string;
  conversationId: string;
}

export interface SharedRoomReadResult {
  placeId: string;
  conversationId: string;
  historyBlockJson: string;
  omittedCount: number;
  omittedRange: { firstTurnId: number; lastTurnId: number } | null;
}

export interface SharedRoomCommitInput {
  placeId: string;
  conversationId: string;
  requestKey: string;
  text: string;
}

export interface RemoteRoomCommitRequest extends SharedRoomCommitInput {
  grantId: string;
  stateHash: string;
}

export interface SharedRoomCommitResult {
  status: "committed";
  placeId: string;
  conversationId: string;
  requestKey: string;
  speakerId: string;
  turnId: number;
}

/** Only refusals that prove no new canonical speech was appended. */
export class RoomCommitRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomCommitRejectedError";
  }
}

export function assertRoomCommitInput(input: SharedRoomCommitInput): void {
  if (![input.placeId, input.conversationId, input.requestKey]
    .every(v => typeof v === "string" && v.trim().length > 0 && v.length <= 256)
    || typeof input.text !== "string" || !input.text.trim() || input.text.length > 2000) {
    throw new RoomCommitRejectedError("shared room commit input is invalid");
  }
}

/**
 * The Incarnation-to-Continuity boundary. It intentionally contains neither a
 * raw store nor a writer capability, so the runtime cannot bypass ANIMA.
 */
export interface RemoteContinuityPort {
  compile(intent: ActiveJoinIntent): Promise<RemoteCompileResult>;
  remember(request: RemoteRememberRequest): Promise<RemoteRememberResult>;
  recall(request: RemoteRecallRequest): Promise<RemoteRecallResult>;
  /** Optional: identities whose memory lives in ANIMA (Eli, abel) answer direct recall here. */
  directRecall?(request: RemoteDirectRecallRequest): Promise<RemoteDirectRecallResult>;
  readRoom?(request: RemoteRoomReadRequest): Promise<SharedRoomReadResult>;
  commitRoom?(request: RemoteRoomCommitRequest, signal?: AbortSignal): Promise<SharedRoomCommitResult>;
  /** Optional: identities that accept a remote session-end batch answer here. */
  consolidate?(request: RemoteConsolidateRequest): Promise<RemoteConsolidateResult>;
}

export function assertActiveJoinIntent(input: ActiveJoinIntent): ActiveJoinIntent {
  if (!input.identity) throw new Error("active join identity is required");
  if (!input.surfaceId) throw new Error("active join surfaceId is required");
  if (!input.message) throw new Error("active join message is required");
  if (input.hostContext && input.hostContext.some((section) => typeof section !== "string")) {
    throw new Error("active join hostContext must contain strings");
  }
  return input;
}

export function assertRemoteRememberRequest(input: RemoteRememberRequest): RemoteRememberRequest {
  if (!input.grantId) throw new Error("remote remember grantId is required");
  if (!input.stateHash) throw new Error("remote remember stateHash is required");
  if (!input.idempotencyKey) throw new Error("remote remember idempotencyKey is required");
  if (!input.entry?.scope || !input.entry.content) throw new Error("remote remember entry is required");
  return input;
}

export function assertRemoteDirectRecallRequest(input: RemoteDirectRecallRequest): RemoteDirectRecallRequest {
  if (!input.grantId) throw new Error("remote direct-recall grantId is required");
  if (!input.stateHash) throw new Error("remote direct-recall stateHash is required");
  if (!input.query?.trim()) throw new Error("remote direct-recall query is required");
  return input;
}

export function assertRemoteRecallRequest(input: RemoteRecallRequest): RemoteRecallRequest {
  if (!input.grantId) throw new Error("remote recall grantId is required");
  if (!input.stateHash) throw new Error("remote recall stateHash is required");
  if (!input.query?.trim()) throw new Error("remote recall query is required");
  if (!input.substrateScope) throw new Error("remote recall substrateScope is required");
  return input;
}

/**
 * A remote session's end-of-session report. The agent writes the summary
 * itself; nothing here is a raw transcript, and candidate learnings are only
 * ever proposals — the agent's own reflection decides what reaches its
 * substrate (never this request).
 */
export interface RemoteConsolidateCandidate {
  claim: string;
  evidence: string;
  confidence: number;
}

export interface RemoteConsolidateBatch {
  sessionId: string;
  /** Monotonic per-session sequence, so a retried batch is a no-op. */
  sequence: number;
  summary: string;
  candidates?: RemoteConsolidateCandidate[];
}

export interface RemoteConsolidateRequest {
  grantId: string;
  stateHash: string;
  idempotencyKey: string;
  batch: RemoteConsolidateBatch;
}

export interface RemoteConsolidateResult {
  episodeId: string;
  /** Proposals appended to the agent's inbox, never substrate writes. */
  proposals: number;
  duplicates: number;
}

/** Upper bounds on one remote batch. Summaries only: no transcript is accepted. */
export const REMOTE_CONSOLIDATE_LIMITS = {
  summaryChars: 2000,
  maxCandidates: 12,
  claimChars: 280,
  evidenceChars: 500,
} as const;

/**
 * The continuity boundary refused a consolidate BEFORE touching the store or
 * the inbox, so nothing landed. Any other failure is an unknown outcome and
 * stays pending (mutation recovery), exactly like remember.
 */
export class ConsolidateRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsolidateRejectedError";
  }
}

export function assertRemoteConsolidateRequest(input: RemoteConsolidateRequest): RemoteConsolidateRequest {
  if (!input.grantId) throw new Error("remote consolidate grantId is required");
  if (!input.stateHash) throw new Error("remote consolidate stateHash is required");
  if (!input.idempotencyKey) throw new Error("remote consolidate idempotencyKey is required");
  const batch = input.batch;
  if (!batch || typeof batch.sessionId !== "string" || !batch.sessionId.trim() || batch.sessionId.length > 256) {
    throw new Error("remote consolidate sessionId is required");
  }
  if (!Number.isInteger(batch.sequence) || batch.sequence < 0) {
    throw new Error("remote consolidate sequence is invalid");
  }
  if (typeof batch.summary !== "string" || !batch.summary.trim()) {
    throw new Error("remote consolidate summary is required");
  }
  if (batch.summary.length > REMOTE_CONSOLIDATE_LIMITS.summaryChars) {
    throw new Error("remote consolidate summary is invalid");
  }
  const candidates = batch.candidates ?? [];
  if (!Array.isArray(candidates)) throw new Error("remote consolidate candidates are invalid");
  if (candidates.length > REMOTE_CONSOLIDATE_LIMITS.maxCandidates) {
    throw new Error("remote consolidate candidates are invalid");
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") throw new Error("remote consolidate candidates are invalid");
    if (typeof candidate.claim !== "string" || !candidate.claim.trim()
      || candidate.claim.length > REMOTE_CONSOLIDATE_LIMITS.claimChars) {
      throw new Error("remote consolidate candidates are invalid");
    }
    if (typeof candidate.evidence !== "string" || !candidate.evidence.trim()
      || candidate.evidence.length > REMOTE_CONSOLIDATE_LIMITS.evidenceChars) {
      throw new Error("remote consolidate candidates are invalid");
    }
    if (typeof candidate.confidence !== "number" || !Number.isFinite(candidate.confidence)
      || candidate.confidence < 0 || candidate.confidence > 1) {
      throw new Error("remote consolidate candidates are invalid");
    }
  }
  return input;
}
