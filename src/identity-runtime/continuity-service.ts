import { randomUUID } from "node:crypto";
import {
  assertActiveJoinIntent,
  assertRemoteDirectRecallRequest,
  assertRemoteRecallRequest,
  assertRemoteRememberRequest,
  RememberRejectedError,
  type ActiveJoinIntent,
  type RemoteCompileResult,
  type RemoteContinuityPort,
  type RemoteDirectRecallRequest,
  type RemoteDirectRecallResult,
  type RemoteRecallRequest,
  type RemoteRecallResult,
  type RemoteRememberRequest,
  type RemoteRememberResult,
  assertRemoteConsolidateRequest,
  ConsolidateRejectedError,
  type RemoteConsolidateRequest,
  type RemoteConsolidateResult,
  assertRoomCommitInput, RoomCommitRejectedError,
  type RemoteRoomReadRequest, type SharedRoomReadResult,
  type RemoteRoomCommitRequest, type SharedRoomCommitInput, type SharedRoomCommitResult,
} from "./contract/remote-continuity.ts";
import { narrowProjectionGrant } from "./contract/projection-grant.ts";
import type { RuntimeProjection } from "./contract/runtime-projection.ts";
import type { AgentMemoryEntry, MemoryScope } from "../memory/contract";
import { ScopeMapper } from "./contract/scope-mapper.ts";
import { ProjectionGrantStore } from "./projection-grant-store";

const DEFAULT_GRANT_TTL_MS = 30 * 60 * 1000;

export interface AnimaContinuityServiceOptions {
  identity: string;
  grantStore: ProjectionGrantStore;
  compileProjection(intent: ActiveJoinIntent): Promise<RuntimeProjection>;
  canonicalStateHash(): string | Promise<string>;
  /** Atomically reserve the canonical revision for this write. */
  claimCurrentState?(stateHash: string):
    | { rollback(): void | Promise<void> }
    | undefined
    | Promise<{ rollback(): void | Promise<void> } | undefined>;
  remember(request: RemoteRememberRequest): Promise<RemoteRememberResult>;
  recall(request: RemoteRecallRequest, scopes: readonly MemoryScope[]): Promise<AgentMemoryEntry[]>;
  /** Free-text recall over this identity's own store; absent means the identity has none to offer. */
  directRecall?(request: { query: string }): Promise<RemoteDirectRecallResult>;
  /** Applies one remote session-end batch (summary -> episode, learnings -> inbox) when a tenant accepts one. */
  consolidate?(
    request: RemoteConsolidateRequest,
    context: { surfaceId: string },
  ): Promise<RemoteConsolidateResult>;
  readRoom?(callerId: string, placeId: string, conversationId: string): SharedRoomReadResult;
  commitRoom?(callerId: string, input: SharedRoomCommitInput, signal?: AbortSignal,
    authorizeGrant?: () => void): Promise<SharedRoomCommitResult>;
  now?: () => number;
  idGenerator?: () => string;
  grantTtlMs?: number;
}

/**
 * ANIMA's Continuity composition boundary. It owns grants and validates their
 * canonical bounds, while compiler/state/writer dependencies remain injected
 * here rather than leaking into the Incarnation runtime.
 */
export class AnimaContinuityService implements RemoteContinuityPort {
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly grantTtlMs: number;
  private readonly scopeMapper = new ScopeMapper();

  constructor(private readonly options: AnimaContinuityServiceOptions) {
    this.now = options.now ?? Date.now;
    this.generateId = options.idGenerator ?? randomUUID;
    this.grantTtlMs = options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
  }

  async compile(input: ActiveJoinIntent): Promise<RemoteCompileResult> {
    const intent = assertActiveJoinIntent(input);
    if (intent.identity !== this.options.identity) {
      throw new Error("active join identity does not match ANIMA continuity identity");
    }
    const projection = await this.options.compileProjection(intent);
    const issuedAt = this.now();
    const grant = {
      grantId: this.generateId(),
      identity: this.options.identity,
      surfaceId: intent.surfaceId,
      projectionId: this.generateId(),
      stateHash: await this.options.canonicalStateHash(),
      writeScopes: [...projection.writeScopes],
      readScopes: [...projection.readScopes],
      declaredSubstrateScopes: [...projection.declaredSubstrateScopes],
      scopeDeclarationStatus: projection.scopeDeclarationStatus,
      issuedAt,
      expiresAt: issuedAt + this.grantTtlMs,
    };
    this.options.grantStore.put(grant);
    return { projection, grant };
  }

  async remember(input: RemoteRememberRequest): Promise<RemoteRememberResult> {
    const { request, reservation } = await this.admitRemember(input);
    try {
      return await this.options.remember(request);
    } catch (error) {
      await reservation?.rollback();
      throw error; // the store was reached: the outcome is unknown, so NOT a RememberRejectedError
    }
  }

  /** Everything that can refuse a remember before the store is touched; each refusal is provably "nothing written". */
  private async admitRemember(input: RemoteRememberRequest) {
    try {
      const request = assertRemoteRememberRequest(input);
      const grant = this.options.grantStore.getActive(request.grantId, this.now());
      if (!grant) throw new Error("projection grant is unavailable");
      narrowProjectionGrant(grant, {
        identity: this.options.identity,
        surfaceId: grant.surfaceId,
        requestedWriteScopes: [request.entry.scope],
        now: this.now(),
      });
      if (request.stateHash !== grant.stateHash) {
        throw new Error("remote remember stateHash is stale");
      }
      const reservation = await this.options.claimCurrentState?.(request.stateHash);
      if (this.options.claimCurrentState && !reservation) throw new Error("remote remember stateHash is stale");
      return { request, reservation };
    } catch (error) {
      if (error instanceof RememberRejectedError) throw error;
      throw new RememberRejectedError(error instanceof Error ? error.message : "remember rejected");
    }
  }

  async directRecall(input: RemoteDirectRecallRequest): Promise<RemoteDirectRecallResult> {
    const request = assertRemoteDirectRecallRequest(input);
    const grant = this.options.grantStore.getActive(request.grantId, this.now());
    if (!grant) throw new Error("projection grant is unavailable");
    if (request.stateHash !== grant.stateHash) throw new Error("remote direct-recall stateHash is stale");
    if (!this.options.directRecall) throw new Error("direct recall is not configured for this identity");
    return this.options.directRecall({ query: request.query });
  }

  /**
   * Remote session-end sync. Every refusal made before the batch is applied is
   * a typed "nothing landed"; a failure after delegation is an unknown outcome
   * (the runtime keeps its outbox row pending and the client retries).
   */
  async consolidate(input: RemoteConsolidateRequest): Promise<RemoteConsolidateResult> {
    let request: RemoteConsolidateRequest;
    let surfaceId: string;
    try {
      request = assertRemoteConsolidateRequest(input);
      const grant = this.options.grantStore.getActive(request.grantId, this.now());
      if (!grant || grant.identity !== this.options.identity) throw new Error("projection grant is unavailable");
      if (request.stateHash !== grant.stateHash) throw new Error("remote consolidate stateHash is stale");
      if (!grant.writeScopes.includes("episode")) {
        throw new Error("remote consolidate summary scope is not granted by lease");
      }
      if (!this.options.consolidate) throw new Error("remote consolidate is unavailable");
      surfaceId = grant.surfaceId;
    } catch (error) {
      throw new ConsolidateRejectedError(error instanceof Error ? error.message : "remote consolidate rejected");
    }
    return this.options.consolidate(request, { surfaceId });
  }

  async readRoom(input: RemoteRoomReadRequest): Promise<SharedRoomReadResult> {
    if (![input.grantId, input.stateHash, input.placeId, input.conversationId]
      .every(value => typeof value === "string" && value.trim().length > 0 && value.length <= 256)) {
      throw new Error("room-read binding is invalid");
    }
    const grant = this.options.grantStore.getActive(input.grantId, this.now());
    if (!grant || grant.identity !== this.options.identity) throw new Error("projection grant is unavailable");
    if (input.stateHash !== grant.stateHash) throw new Error("room-read stateHash is stale");
    if (!this.options.readRoom) throw new Error("shared room read is unavailable");
    return this.options.readRoom(this.options.identity, input.placeId, input.conversationId);
  }

  async commitRoom(input: RemoteRoomCommitRequest, signal?: AbortSignal): Promise<SharedRoomCommitResult> {
    assertRoomCommitInput(input);
    const { grantId, stateHash, placeId, conversationId, requestKey, text } = input;
    const authorize = () => {
      const grant = this.options.grantStore.getActive(grantId, this.now());
      if (!grant || grant.identity !== this.options.identity) throw new RoomCommitRejectedError("projection grant is unavailable");
      if (stateHash !== grant.stateHash) throw new RoomCommitRejectedError("room-commit stateHash is stale");
    };
    authorize();
    if (!this.options.commitRoom) throw new RoomCommitRejectedError("shared room commit is unavailable");
    return this.options.commitRoom(this.options.identity, { placeId, conversationId, requestKey, text }, signal, authorize);
  }

  async recall(input: RemoteRecallRequest): Promise<RemoteRecallResult> {
    const request = assertRemoteRecallRequest(input);
    const grant = this.options.grantStore.getActive(request.grantId, this.now());
    if (!grant) throw new Error("projection grant is unavailable");
    if (request.stateHash !== grant.stateHash) throw new Error("remote recall stateHash is stale");

    const declaredScopes = grant.scopeDeclarationStatus === "implemented"
      ? grant.declaredSubstrateScopes ?? []
      : [];
    const resolution = this.scopeMapper.resolve(request.substrateScope, declaredScopes);
    if (!resolution.ok) return { resolution, results: [] };

    const readScopes = grant.readScopes ?? [];
    if (resolution.memoryScopes.some((scope) => !readScopes.includes(scope))) {
      return {
        resolution: {
          ok: false,
          requestedScope: request.substrateScope,
          diagnostic: {
            code: "read_scope_not_granted",
            message: `Scope "${request.substrateScope}" resolves to a memory scope outside the grant read capability.`,
          },
        },
        results: [],
      };
    }

    return {
      resolution,
      results: await this.options.recall(request, resolution.memoryScopes),
    };
  }
}
