import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { AgentMemoryEntry } from "../../../src/memory/contract.ts";
import { LeaseStore, buildManifest } from "@anima/continuity-core";
import type { IncarnationLease } from "@anima/continuity-core";
import { narrowProjectionGrant } from "../../../src/identity-runtime/contract/projection-grant.ts";
import { tagProvenance } from "./remember-provenance.ts";
import {
  RememberRejectedError,
  RoomCommitRejectedError,
  assertRoomCommitInput,
  type SharedRoomCommitResult,
  type ActiveJoinIntent,
  type RemoteContinuityPort,
  type RemoteRecallResult,
  type RemoteRememberResult,
} from "../../../src/identity-runtime/contract/remote-continuity.ts";
import { RuntimeEventStore } from "../../../src/identity-runtime/contract/runtime-events.ts";
import { assertMeshInstallationHint, type MeshEnrollmentPort, type MeshEnrollmentResult, type MeshInstallationHint, type MeshSendInput } from "./mesh-enrollment.ts";
import { StaticServiceContinuity, staticJoinResult } from "./service-continuity.ts";
import { tenantInstanceId } from "./tenant-instance-id.ts";
import { TenantMutationOutbox } from "./tenant-mutation-outbox.ts";

const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

/** Omitted kind means a compiled model agent, which is what every pre-existing definition is. */
function resolveTenantKind(tenant: TenantRuntimeTenant): TenantKind {
  return tenant.kind ?? "agent";
}

export interface TenantMeshRegistrationPort {
  registerRecipient(registration: {
    instance_id: string;
    agent_name?: string;
    platform?: string;
    active?: boolean;
  }): void;
}

export interface TenantDirectRecallPolicy {
  recall(query: string): Promise<unknown>;
}

/**
 * Whether a tenant is a compiled model agent or a non-model service installation
 * Omitted means `"agent"`, so every definition written before the
 * service kind existed keeps its current meaning.
 */
export type TenantKind = "agent" | "service";

export interface TenantRuntimeTenant {
  kind?: TenantKind;
  continuity: RemoteContinuityPort;
  mesh?: TenantMeshRegistrationPort;
  platform?: string;
  recallPolicy?: TenantDirectRecallPolicy;
}

export interface TenantIdentityRuntimeOptions {
  dbPath: string;
  tenants: ReadonlyMap<string, TenantRuntimeTenant>;
  now?: () => number;
  idGenerator?: () => string;
  leaseTtlMs?: number;
  /** Colony Mesh admission; absent means joins never touch Mesh (colony-mesh Task 4). */
  meshEnrollment?: MeshEnrollmentPort;
  /** One line per join/recall/remember ; defaults to structured JSON on console. */
  log?: (level: "info" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

export interface TenantHealth {
  tenants: Array<{ agentId: string; pendingMutations: number }>;
}

export interface RuntimeDrainResult {
  outcome: "drained" | "timed_out";
  activeOperations: number;
  pendingMutations: number;
}

export class RuntimeDrainingError extends Error {
  constructor() { super("identity runtime is draining"); }
}

function structuredLog(level: "info" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  console[level === "error" ? "error" : "log"](
    JSON.stringify({ level, ts: new Date().toISOString(), msg, ...fields }),
  );
}

export interface TenantJoinInput {
  clientId: string;
  surfaceId: string;
  message: string;
  cartridgeOverride?: string | null;
  hostContext?: string[];
  /** Installation metadata for the final best-effort Mesh enrollment. */
  mesh?: MeshInstallationHint;
}

export interface TenantJoinResponse {
  projection: string;
  projectionId: string;
  stateHash: string;
  leaseId: string;
  expiresAt: number;
  writeScopes: string[];
  declaredSubstrateScopes: string[];
  scopeDeclarationStatus: "unimplemented" | "implemented" | "none";
  sessionToken: string;
  /**
   * Content hash of the compiled identity source (soul + gene), already
   * computed by every compiler (AnimaProjectionCompiler and both bespoke
   * ones) but never surfaced before. A client — or an operator — can compare this
   * across joins to detect an identity file changed silently between sessions, instead of only
   * trusting that nothing did.
   */
  kernelVersion: string;
  /**
   * Hash of the resolved substrate scopes (relativePath/trust/weight),
   * already computed by AnimaProjectionCompiler as substrateViewVersion but
   * never surfaced before. kernelVersion only catches a content edit
   * (soul/gene text changing) — it does not move if substrate.map.yaml itself changes (a scope's paths
   * added/removed, or its trust/weight retuned). The two signals are
   * independent; a client needs both to tell content drift from config drift.
   */
  substrateViewVersion?: string;
  /** Present only when Mesh enrollment is configured and the join carried `mesh`. */
  meshEnrollment?: MeshEnrollmentResult;
}

export interface TenantRememberInput {
  leaseId: string;
  clientId: string;
  sessionToken: string;
  stateHash: string;
  idempotencyKey: string;
  entry: Omit<AgentMemoryEntry, "id" | "createdAt">;
}

export interface TenantRecallInput {
  leaseId: string;
  clientId: string;
  sessionToken: string;
  stateHash: string;
  query: string;
  substrateScope: string;
}

export interface TenantDirectRecallInput {
  leaseId: string;
  clientId: string;
  sessionToken: string;
  /** Same guard as recall/remember: the caller must hold the lease's current projection state. */
  stateHash: string;
  query: string;
}

export interface TenantRoomReadInput extends Omit<TenantDirectRecallInput, "query"> {
  placeId: string;
  conversationId: string;
}

export interface TenantRoomCommitInput extends TenantRoomReadInput {
  requestKey: string;
  text: string;
}

interface TenantSession {
  leaseId: string;
  agentId: string;
  clientId: string;
  sessionToken: string;
  grantId: string;
}

/**
 * Shared incarnation-plane authority for registered identity tenants.
 * Canonical prompt composition and raw memory remain behind each tenant's
 * ANIMA-owned continuity adapter.
 */
export class TenantIdentityRuntime {
  private draining = false;
  private closed = false;
  private activeOperations = 0;
  private drainPromise?: Promise<RuntimeDrainResult>;
  private onIdle?: () => void;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly leaseTtlMs: number;
  private readonly leases: LeaseStore;
  private readonly events: RuntimeEventStore;
  private readonly outbox: TenantMutationOutbox;
  private readonly sessions: Database;
  private readonly log: (level: "info" | "error", msg: string, fields?: Record<string, unknown>) => void;

  constructor(private readonly options: TenantIdentityRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.id = options.idGenerator ?? randomUUID;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.log = options.log ?? structuredLog;
    this.leases = new LeaseStore(options.dbPath);
    this.events = new RuntimeEventStore(options.dbPath);
    this.outbox = new TenantMutationOutbox(this.events);
    this.sessions = new Database(options.dbPath, { create: true });
    this.sessions.run(
      "CREATE TABLE IF NOT EXISTS identity_runtime_sessions (" +
        "lease_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, " +
        "client_id TEXT NOT NULL, session_token TEXT NOT NULL, grant_id TEXT NOT NULL, " +
        "kind TEXT NOT NULL DEFAULT 'agent')",
    );
    // Databases created before the service kind existed gain the column without rewriting rows:
    // every existing session was a compiled model agent, which is exactly the default.
    const columns = this.sessions.query("PRAGMA table_info(identity_runtime_sessions)").all() as
      Array<{ name: string }>;
    if (!columns.some((column) => column.name === "kind")) {
      this.sessions.run("ALTER TABLE identity_runtime_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'");
    }
    for (const [agentId, tenant] of options.tenants) {
      if (resolveTenantKind(tenant) !== "service") continue;
      // A service must not carry model-agent capability. Refusing at construction means a
      // misconfiguration cannot mint a single lease.
      if (tenant.recallPolicy) throw new Error("service tenant must not declare a recall policy");
      if (!(tenant.continuity instanceof StaticServiceContinuity)) {
        throw new Error("service tenant requires a static service continuity port");
      }
      void agentId;
    }
  }

  async join(agentId: string, input: TenantJoinInput): Promise<TenantJoinResponse> {
    return this.logged("join", { agentId, clientId: input.clientId, surfaceId: input.surfaceId }, () => this.joinInternal(agentId, input));
  }

  private async joinInternal(agentId: string, input: TenantJoinInput): Promise<TenantJoinResponse> {
    const tenant = this.tenant(agentId);
    if (!input.clientId || !input.surfaceId || !input.message) {
      throw new Error("clientId, surfaceId and message are required");
    }
    if (this.outbox.hasPending(agentId)) {
      throw new Error("identity runtime mutation recovery required");
    }
    if (input.mesh) assertMeshInstallationHint(input.mesh);

    const now = this.now();
    // One explicit branch at the single place a compiled identity would be produced. A service
    // tenant never reaches the continuity port; everything after this point is shared, so a service
    // still goes through lease minting, session storage and Mesh registration.
    const remote = resolveTenantKind(tenant) === "service"
      ? staticJoinResult(agentId, input.surfaceId, now)
      : await tenant.continuity.compile({
        identity: agentId,
        surfaceId: input.surfaceId,
        message: input.message,
        cartridgeOverride: input.cartridgeOverride,
        hostContext: input.hostContext,
      } satisfies ActiveJoinIntent);
    const narrowed = narrowProjectionGrant(remote.grant, {
      identity: agentId,
      surfaceId: input.surfaceId,
      requestedWriteScopes: remote.projection.writeScopes,
      now,
    });
    const manifest = buildManifest({
      agentId,
      kernelVersion: remote.projection.kernelVersion,
      cartridgeVersions: remote.projection.cartridgeVersions,
      substrateViewVersion: remote.projection.substrateViewVersion,
      memoryDomainVersions: { identity: "0", private: "0", heartwood: "0" },
      surfaceId: input.surfaceId,
      compiledAt: now,
      promptStaticHash: remote.projection.promptStaticHash,
    });
    const lease = this.leases.mint({
      leaseId: this.id(),
      agentId,
      surfaceId: input.surfaceId,
      baseManifest: {
        ...manifest,
        stateHash: remote.grant.stateHash,
        projectionId: remote.grant.projectionId,
      },
      readScopes: remote.grant.readScopes ? narrowed.readScopes : remote.projection.readScopes,
      writeScopes: narrowed.writeScopes,
      proposalScopes: remote.projection.proposalScopes,
      idempotencyNamespace: this.id(),
      issuedAt: now,
      expiresAt: Math.min(now + this.leaseTtlMs, narrowed.expiresAt),
    });
    const sessionToken = this.id();
    this.sessions.run(
      "INSERT INTO identity_runtime_sessions " +
        "(lease_id, agent_id, client_id, session_token, grant_id, kind) VALUES (?, ?, ?, ?, ?, ?)",
      [lease.leaseId, agentId, input.clientId, sessionToken, narrowed.grantId, resolveTenantKind(tenant)],
    );

    const registeredInstanceId = tenantInstanceId(agentId, input.surfaceId);
    try {
      tenant.mesh?.registerRecipient({
        instance_id: registeredInstanceId,
        agent_name: agentId,
        platform: tenant.platform,
        active: true,
      });
    } catch (error) {
      console.error("mesh registration failed for " + registeredInstanceId + ":", error);
    }

    // The deadline is checked when enrollment would start: a client that gave up at notAfter is never enrolled later.
    const meshEnrollment: MeshEnrollmentResult | undefined = input.mesh && this.options.meshEnrollment
      ? input.mesh.notAfter !== undefined && this.now() > input.mesh.notAfter
        ? { status: "expired" }
        : await this.options.meshEnrollment.enroll(agentId, input.mesh)
      : undefined;

    return {
      ...(meshEnrollment ? { meshEnrollment } : {}),
      projection: remote.projection.prompt,
      projectionId: remote.grant.projectionId,
      stateHash: remote.grant.stateHash,
      leaseId: lease.leaseId,
      expiresAt: lease.expiresAt,
      writeScopes: lease.writeScopes,
      declaredSubstrateScopes: remote.projection.declaredSubstrateScopes,
      scopeDeclarationStatus: remote.projection.scopeDeclarationStatus,
      sessionToken,
      kernelVersion: remote.projection.kernelVersion,
      substrateViewVersion: remote.projection.substrateViewVersion,
    };
  }

  /** A fresh admission proof for the session's own agent, so a sidecar can re-join without a full identity join. */
  async meshProof(input: Pick<TenantRememberInput, "leaseId" | "clientId" | "sessionToken"> & { notAfter?: number }): Promise<{ proof: string }> {
    return this.logged("mesh-proof", { leaseId: input.leaseId, clientId: input.clientId }, async () => {
      const { session } = this.authorize(input);
      if (!this.options.meshEnrollment) throw new Error("mesh enrollment is not configured");
      return { proof: this.options.meshEnrollment.proof(session.agentId, input.notAfter) };
    });
  }

  /** The Colony Mesh directory, read with a grant for the session's own agent. */
  async meshList(input: Pick<TenantRememberInput, "leaseId" | "clientId" | "sessionToken">): Promise<unknown> {
    return this.logged("mesh-list", { leaseId: input.leaseId, clientId: input.clientId }, async () => {
      const { session } = this.authorize(input);
      const mesh = this.options.meshEnrollment;
      if (!mesh?.list) throw new Error("mesh enrollment is not configured");
      return mesh.list(session.agentId);
    });
  }

  /** One message from the session's own agent to one exact mesh ID; the content is never logged. */
  async meshSend(input: Pick<TenantRememberInput, "leaseId" | "clientId" | "sessionToken"> & MeshSendInput): Promise<unknown> {
    return this.logged("mesh-send", { leaseId: input.leaseId, clientId: input.clientId, target: input.target, messageId: input.messageId }, async () => {
      const { session } = this.authorize(input);
      const mesh = this.options.meshEnrollment;
      if (!mesh?.send) throw new Error("mesh enrollment is not configured");
      if (!input.target.includes("@")) throw new Error("mesh target is invalid");
      if (!input.content || !input.messageId) throw new Error("mesh message is invalid");
      return mesh.send(session.agentId, {
        target: input.target, content: input.content, messageId: input.messageId,
        ...(input.from !== undefined ? { from: input.from } : {}),
      });
    });
  }

  async remember(input: TenantRememberInput): Promise<RemoteRememberResult> {
    return this.logged("remember", { agentId: this.agentIdForLease(input.leaseId), leaseId: input.leaseId, clientId: input.clientId }, () => this.rememberInternal(input));
  }

  private async rememberInternal(input: TenantRememberInput): Promise<RemoteRememberResult> {
    const { lease, session, tenant } = this.authorize(input);
    if (input.stateHash !== lease.baseManifest.stateHash) {
      throw new Error("remember stateHash is stale");
    }
    if (!lease.writeScopes.includes(input.entry.scope)) {
      throw new Error("remember scope is not granted by lease");
    }
    const claim = this.outbox.claim(
      session.agentId,
      lease.leaseId,
      "remember",
      input.idempotencyKey,
      this.now(),
    );
    if (claim === "pending") throw new Error("identity runtime mutation recovery required");
    if (claim !== "claimed") return claim.result as unknown as RemoteRememberResult;
    let result: RemoteRememberResult;
    try {
      result = await tenant.continuity.remember({
        grantId: session.grantId,
        stateHash: input.stateHash,
        idempotencyKey: input.idempotencyKey,
        entry: tagProvenance(input.entry, { clientId: input.clientId, surfaceId: lease.surfaceId }),
      });
    } catch (error) {
      // Only a proven pre-write refusal may release the row. Any other failure
      // (transport, store) is an unknown outcome and stays pending on purpose.
      if (error instanceof RememberRejectedError) {
        this.outbox.abandon(session.agentId, lease.leaseId, "remember", input.idempotencyKey);
      }
      throw error;
    }
    this.outbox.complete(
      session.agentId,
      lease.leaseId,
      "remember",
      input.idempotencyKey,
      { ...result },
    );
    return result;
  }

  async recall(input: TenantRecallInput): Promise<RemoteRecallResult> {
    return this.logged("recall", { agentId: this.agentIdForLease(input.leaseId), leaseId: input.leaseId, clientId: input.clientId }, () => this.recallInternal(input));
  }

  private async recallInternal(input: TenantRecallInput): Promise<RemoteRecallResult> {
    const { lease, session, tenant } = this.authorize(input);
    if (input.stateHash !== lease.baseManifest.stateHash) {
      throw new Error("recall stateHash is stale");
    }
    return tenant.continuity.recall({
      grantId: session.grantId,
      stateHash: input.stateHash,
      query: input.query,
      substrateScope: input.substrateScope,
    });
  }

  async directRecall(input: TenantDirectRecallInput): Promise<unknown> {
    return this.logged("directRecall", { agentId: this.agentIdForLease(input.leaseId), leaseId: input.leaseId, clientId: input.clientId }, () => this.directRecallInternal(input));
  }

  async readRoom(input: TenantRoomReadInput) {
    return this.logged("readRoom", { agentId: this.agentIdForLease(input.leaseId), leaseId: input.leaseId, clientId: input.clientId }, async () => {
      const { lease, session, tenant } = this.authorize(input);
      if (input.stateHash !== lease.baseManifest.stateHash) throw new Error("room-read stateHash is stale");
      if (!tenant.continuity.readRoom) throw new Error("shared room read is unavailable");
      return tenant.continuity.readRoom({
        grantId: session.grantId, stateHash: input.stateHash,
        placeId: input.placeId, conversationId: input.conversationId,
      });
    });
  }

  async commitRoom(input: TenantRoomCommitInput, signal?: AbortSignal): Promise<SharedRoomCommitResult> {
    return this.logged("commitRoom", { agentId: this.agentIdForLease(input.leaseId), leaseId: input.leaseId, clientId: input.clientId }, async () => {
      let authorized;
      try {
        assertRoomCommitInput(input);
        authorized = this.authorize(input);
        if (input.stateHash !== authorized.lease.baseManifest.stateHash) throw new Error("room-commit stateHash is stale");
        if (!authorized.tenant.continuity.commitRoom) throw new Error("shared room commit is unavailable");
        if (signal?.aborted) throw new Error("shared room commit cancelled");
      } catch (error) {
        throw new RoomCommitRejectedError(error instanceof Error ? error.message : "shared room commit rejected");
      }
      const { lease, session, tenant } = authorized;
      const expiry = AbortSignal.timeout(Math.max(0, Math.floor(lease.expiresAt - this.now())));
      // After delegation begins any unmarked failure has an unknown outcome.
      return tenant.continuity.commitRoom!({
        grantId: session.grantId, stateHash: input.stateHash, placeId: input.placeId,
        conversationId: input.conversationId, requestKey: input.requestKey, text: input.text,
      }, signal ? AbortSignal.any([signal, expiry]) : expiry);
    });
  }

  private async directRecallInternal(input: TenantDirectRecallInput): Promise<unknown> {
    const { lease, session, tenant } = this.authorize(input);
    // Fail closed before any memory is read: every read path must carry a
    // current stateHash, including direct recall.
    if (input.stateHash !== lease.baseManifest.stateHash) {
      throw new Error("direct-recall stateHash is stale");
    }
    if (!input.query.trim()) {
      throw new Error("query is required");
    }
    if (tenant.recallPolicy) return tenant.recallPolicy.recall(input.query);
    if (tenant.continuity.directRecall) {
      return tenant.continuity.directRecall({
        grantId: session.grantId,
        stateHash: input.stateHash,
        query: input.query,
      });
    }
    throw new Error("tenant direct recall is unavailable");
  }

  /** Stuck mutations for a tenant — an unknown-outcome remember blocks join until one of these is resolved. */
  pendingMutations(agentId: string): Array<{ leaseId: string; operation: string; idempotencyKey: string; createdAt: number }> {
    return this.outbox.pending(agentId);
  }

  /** Per-tenant status for /health, so diagnosis no longer needs hand-written probes. */
  health(): TenantHealth {
    return {
      tenants: [...this.options.tenants.keys()].map((agentId) => ({
        agentId,
        pendingMutations: this.outbox.pending(agentId).length,
      })),
    };
  }

  private agentIdForLease(leaseId: string): string | undefined {
    if (this.draining || this.closed) throw new RuntimeDrainingError();
    return this.leases.get(leaseId)?.agentId;
  }

  /** One log line per join/recall/remember/directRecall, success or failure. */
  private async logged<T>(op: string, fields: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    if (this.draining || this.closed) throw new RuntimeDrainingError();
    this.activeOperations++;
    try {
      const result = await fn();
      this.log("info", op, { ...fields, outcome: "ok" });
      return result;
    } catch (error) {
      this.log("error", op, { ...fields, outcome: "error", error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.activeOperations--;
      if (this.activeOperations === 0) this.onIdle?.();
    }
  }

  get accepting(): boolean { return !this.draining && !this.closed; }

  /** Unknown writes remain pending. A timeout does not close handles under live work. */
  drain(timeoutMs = 10000): Promise<RuntimeDrainResult> {
    if (this.drainPromise) return this.drainPromise;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("invalid drain timeout");
    this.draining = true;
    this.drainPromise = (async () => {
      if (this.activeOperations > 0) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { this.onIdle = undefined; resolve(); }, timeoutMs);
          this.onIdle = () => { clearTimeout(timer); this.onIdle = undefined; resolve(); };
        });
      }
      const result: RuntimeDrainResult = {
        outcome: this.activeOperations === 0 ? "drained" : "timed_out",
        activeOperations: this.activeOperations,
        pendingMutations: this.health().tenants.reduce((sum, tenant) => sum + tenant.pendingMutations, 0),
      };
      if (result.outcome === "drained") this.close();
      return result;
    })();
    return this.drainPromise;
  }

  /**
   * Recovery: release a stuck row so join can proceed again. Safe only because
   * remember is idempotency-keyed end to end (ANIMA's continuity dedupes on the
   * same key before writing) — abandoning here never causes a duplicate write,
   * it only lets the original client retry with the key it already holds.
   */
  abandonPendingMutation(agentId: string, leaseId: string, operation: string, idempotencyKey: string): void {
    this.outbox.abandon(agentId, leaseId, operation, idempotencyKey);
  }

  close(): void {
    if (this.closed) return;
    if (this.activeOperations > 0) throw new Error("cannot close identity runtime with active operations");
    this.closed = true;
    this.sessions.close();
    this.events.close();
    this.leases.close();
  }

  private authorize(
    input: Pick<TenantRememberInput, "leaseId" | "clientId" | "sessionToken">,
  ): {
    lease: IncarnationLease;
    session: TenantSession;
    tenant: TenantRuntimeTenant;
  } {
    const lease = this.leases.get(input.leaseId);
    if (!lease || !this.leases.isActive(lease, this.now())) {
      throw new Error("lease is unavailable");
    }
    const session = this.sessions.query(
      "SELECT lease_id AS leaseId, agent_id AS agentId, client_id AS clientId, " +
        "session_token AS sessionToken, grant_id AS grantId " +
        "FROM identity_runtime_sessions WHERE lease_id = ?",
    ).get(input.leaseId) as TenantSession | null;
    if (
      !session
      || session.agentId !== lease.agentId
      || session.clientId !== input.clientId
      || session.sessionToken !== input.sessionToken
    ) {
      throw new Error("runtime session is unavailable");
    }
    return { lease, session, tenant: this.tenant(session.agentId) };
  }

  private tenant(agentId: string): TenantRuntimeTenant {
    const tenant = this.options.tenants.get(agentId);
    if (!tenant) throw new Error("identity tenant is not registered");
    return tenant;
  }
}
