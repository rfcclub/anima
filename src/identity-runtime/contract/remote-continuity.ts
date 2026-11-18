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
