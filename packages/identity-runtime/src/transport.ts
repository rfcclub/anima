import type { ProjectionCompileRequest, ProposeInput } from "@anima/continuity-core";
import type { RuntimeProjection } from "../../../src/identity-runtime/contract/runtime-projection.ts";
import type { IdentityRuntimeCompileJoin, IdentityRuntimeJoin } from "../../../src/identity-runtime/contract/transport-types.ts";
import type { MemoryScope } from "../../../src/memory/contract.ts";
import type { SessionRecallRequest } from "./identity-session.ts";
import type { IdentityRuntimeRegistry } from "./runtime-registry.ts";
import { randomUUID } from "node:crypto";

export type TransportOperation = "join" | "recall" | "remember" | "propose" | "promote" | "promotion-status" | "events";
export interface TransportRequest { version: "v1"; token?: string; operation: TransportOperation; body: Record<string, unknown>; }
export interface TransportResponse { status: number; body: Record<string, unknown>; }
export interface IdentityRuntimeServer { port: number; stop(closeActiveConnections?: boolean): void; }

const OPERATIONS: ReadonlySet<string> = new Set(["join", "recall", "remember", "propose", "promote", "promotion-status", "events"]);

/**
 * Bearer-token API. `listen()` binds a real HTTP endpoint; production passes a
 * Tailscale address as `hostname`, while tests use loopback and an ephemeral port.
 */
export class VersionedIdentityTransport {
  private readonly sessions = new Map<string, { clientId: string; token: string }>();

  constructor(private readonly registry: IdentityRuntimeRegistry, private readonly auth: { token: string; trustedCompilerToken?: string; approverCredentials?: Readonly<Record<string, string>> }) {}

  listen(input: { hostname: string; port: number }): IdentityRuntimeServer {
    const server = Bun.serve({
      hostname: input.hostname,
      port: input.port,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== "/v1/identity") {
          return Response.json({ error: "not_found" }, { status: 404 });
        }
        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return Response.json({ error: "invalid_json" }, { status: 400 });
        }
        if (!isTransportPayload(payload)) return Response.json({ error: "invalid_request" }, { status: 400 });
        const response = await this.handle({
          version: payload.version,
          operation: payload.operation,
          body: payload.body,
          token: bearerToken(request.headers.get("authorization")),
        });
        return Response.json(response.body, { status: response.status });
      },
    });
    if (server.port === undefined) throw new Error("identity runtime listener did not receive a port");
    return { port: server.port, stop: (closeActiveConnections = false) => server.stop(closeActiveConnections) };
  }

  async handle(request: TransportRequest): Promise<TransportResponse> {
    if (request.version !== "v1") return failure(400, "unsupported_version");
    if (!OPERATIONS.has(request.operation)) return failure(400, "unsupported_operation");
    if (request.operation === "join") {
      if (request.body.projection !== undefined) {
        if (!this.auth.trustedCompilerToken || request.token !== this.auth.trustedCompilerToken) return failure(403, "untrusted_compiler");
      } else if (request.token !== this.auth.token) return failure(401, "unauthorized");
    } else if (request.operation === "promote") {
      if (!this.approverFor(request.token)) return failure(401, "unauthorized");
    } else {
      const leaseId = stringField(request.body, "leaseId");
      const clientId = stringField(request.body, "clientId");
      const capability = this.sessions.get(leaseId);
      if (!capability || capability.clientId !== clientId || capability.token !== request.token) return failure(401, "unauthorized");
    }

    const agentId = stringField(request.body, "agentId");
    const runtime = this.registry.get(agentId);
    if (!runtime) return failure(404, "identity_not_found");

    try {
      switch (request.operation) {
        case "join": return await this.join(runtime, request.body);
        case "recall": return await this.recall(runtime, request.body);
        case "remember": return await this.remember(runtime, request.body);
        case "propose": return await this.propose(runtime, request.body);
        case "promotion-status": return this.proposalStatus(runtime, request.body);
        case "promote": return await this.promote(runtime, request.body, this.approverFor(request.token)!);
        case "events": return this.events(runtime, request.body);
      }
    } catch (error) {
      return failure(400, error instanceof Error ? error.name : "bad_request");
    }
  }

  private async join(runtime: ReturnType<IdentityRuntimeRegistry["get"]> & {}, body: Record<string, unknown>): Promise<TransportResponse> {
    const clientId = stringField(body, "clientId");
    const surfaceId = stringField(body, "surfaceId");
    if (!clientId || !surfaceId) return failure(400, "invalid_join");
    const compile = parseCompileRequest(body.compile);
    if (body.compile !== undefined && !compile) return failure(400, "invalid_compile");
    const projection = parseRuntimeProjection(body.projection);
    if (body.projection !== undefined && !projection) return failure(400, "invalid_projection");
    const joined = await runtime.join({ clientId, surfaceId }, { compile, projection });
    const capabilityToken = randomUUID();
    this.sessions.set(joined.leaseId, { clientId, token: capabilityToken });
    return {
      status: 200,
      body: {
        projection: joined.projection, projectionId: joined.projectionId, stateHash: joined.stateHash,
        leaseId: joined.leaseId, expiresAt: joined.expiresAt,
        scopeDeclarationStatus: joined.scopeDeclarationStatus, capabilityToken,
      },
    };
  }

  private async recall(runtime: NonNullable<ReturnType<IdentityRuntimeRegistry["get"]>>, body: Record<string, unknown>): Promise<TransportResponse> {
    const query = stringField(body, "query");
    const substrateScope = stringField(body, "substrateScope");
    if (!query || !substrateScope) return failure(400, "invalid_recall");
    const result = await runtime.recall(stringField(body, "leaseId"), { query, substrateScope } satisfies SessionRecallRequest);
    return { status: 200, body: { resolution: result.resolution, results: result.results } };
  }

  private async propose(runtime: NonNullable<ReturnType<IdentityRuntimeRegistry["get"]>>, body: Record<string, unknown>): Promise<TransportResponse> {
    const scope = stringField(body, "scope");
    const content = stringField(body, "content");
    const stateHash = stringField(body, "stateHash");
    const idempotencyKey = stringField(body, "idempotencyKey");
    const evidence = stringArrayField(body, "evidence");
    if (!scope || !content || !stateHash || !idempotencyKey || !evidence) return failure(400, "invalid_proposal");
    const proposal = await runtime.propose(stringField(body, "leaseId"), { scope: scope as ProposeInput["scope"], content, evidence, stateHash, idempotencyKey });
    return { status: 200, body: { proposalId: proposal.proposalId, status: proposal.status } };
  }

  private async remember(runtime: NonNullable<ReturnType<IdentityRuntimeRegistry["get"]>>, body: Record<string, unknown>): Promise<TransportResponse> {
    const stateHash = stringField(body, "stateHash");
    const idempotencyKey = stringField(body, "idempotencyKey");
    const entry = isRecord(body.entry) ? body.entry : undefined;
    if (!stateHash || !idempotencyKey || !entry || !isMemoryEntry(entry)) return failure(400, "invalid_remember");
    const written = await runtime.remember(stringField(body, "leaseId"), { stateHash, idempotencyKey, entry });
    return { status: 200, body: { id: written.id, createdAt: written.createdAt } };
  }

  private proposalStatus(runtime: NonNullable<ReturnType<IdentityRuntimeRegistry["get"]>>, body: Record<string, unknown>): TransportResponse {
    const status = runtime.proposalStatusForLease(stringField(body, "proposalId"), stringField(body, "leaseId"));
    return status ? { status: 200, body: status } : failure(404, "proposal_not_found");
  }

  private async promote(runtime: NonNullable<ReturnType<IdentityRuntimeRegistry["get"]>>, body: Record<string, unknown>, approver: string): Promise<TransportResponse> {
    const receipt = await runtime.promote(stringField(body, "proposalId"), approver);
    return { status: 200, body: { receiptId: receipt.receiptId, proposalId: receipt.proposalId, domain: receipt.domain, newVersion: receipt.newVersion } };
  }

  private events(runtime: NonNullable<ReturnType<IdentityRuntimeRegistry["get"]>>, body: Record<string, unknown>): TransportResponse {
    return { status: 200, body: { events: runtime.eventsForLease(stringField(body, "leaseId"), stringField(body, "clientId"), numberField(body, "limit") ?? 20) } };
  }

  private approverFor(token: string | undefined): string | undefined {
    return Object.entries(this.auth.approverCredentials ?? {}).find(([, credential]) => credential === token)?.[0];
  }
}

export interface IdentityRuntimeClientOptions {
  endpoint: string;
  agentId: string;
  clientId: string;
  bootstrapToken: string;
  /** Separate capability held only by the trusted canonical compiler. */
  compilerToken?: string;
  fetchImpl?: typeof fetch;
}


/** Remote capability facade. It knows an endpoint and bearer tokens, never an authority or SQLite path. */
export class IdentityRuntimeClient {
  private readonly fetchImpl: typeof fetch;
  private session: { leaseId: string; capabilityToken: string } | undefined;

  constructor(private readonly input: IdentityRuntimeClientOptions) {
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async join(input: string | IdentityRuntimeCompileJoin): Promise<IdentityRuntimeJoin> {
    const join = typeof input === "string"
      ? { clientId: this.input.clientId, surfaceId: input }
      : input;
    if (join.clientId !== this.input.clientId) throw new Error("identity runtime client id does not match configured client");
    if (typeof input !== "string") {
      if (input.compile.identity !== this.input.agentId) throw new Error("identity runtime compile identity does not match configured agent");
      if (input.compile.surfaceId !== input.surfaceId) throw new Error("identity runtime compile surface does not match join surface");
    }
    const suppliedProjection = typeof input !== "string" && input.projection !== undefined;
    if (suppliedProjection && !this.input.compilerToken) {
      throw new Error("identity runtime compiler token is required for a supplied projection");
    }
    const body = await this.send("join", {
      agentId: this.input.agentId,
      clientId: join.clientId,
      surfaceId: join.surfaceId,
      ...(typeof input === "string" ? {} : { compile: input.compile }),
      ...(!suppliedProjection ? {} : { projection: input.projection }),
    }, suppliedProjection ? this.input.compilerToken! : this.input.bootstrapToken);
    const joined = requireJoin(body);
    this.session = { leaseId: joined.leaseId, capabilityToken: joined.capabilityToken };
    const { capabilityToken: _capabilityToken, ...publicJoin } = joined;
    return publicJoin;
  }

  async recall(query: string, substrateScope: string): Promise<Record<string, unknown>> {
    return this.activeRequest("recall", { query, substrateScope });
  }

  async remember(stateHash: string, idempotencyKey: string, entry: { scope: string; content: string; tags: string[]; confidence: number; source: string; metadata?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return this.activeRequest("remember", { stateHash, idempotencyKey, entry });
  }

  async propose(input: ProposeInput): Promise<Record<string, unknown>> {
    return this.activeRequest("propose", input as unknown as Record<string, unknown>);
  }

  async proposalStatus(proposalId: string): Promise<Record<string, unknown>> {
    return this.activeRequest("promotion-status", { proposalId });
  }

  async events(limit = 20): Promise<Record<string, unknown>> {
    return this.activeRequest("events", { limit });
  }

  private async activeRequest(operation: Exclude<TransportOperation, "join">, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.session) throw new Error("identity runtime client has not joined");
    return this.send(operation, { ...body, agentId: this.input.agentId, clientId: this.input.clientId, leaseId: this.session.leaseId }, this.session.capabilityToken);
  }

  private async send(operation: TransportOperation, body: Record<string, unknown>, token: string): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.input.endpoint.replace(/\/$/, "")}/v1/identity`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ version: "v1", operation, body }),
    });
    const payload: unknown = await response.json();
    if (!isRecord(payload)) throw new Error("identity runtime returned invalid JSON");
    if (!response.ok) throw new Error(`identity runtime ${operation} failed: ${String(payload.error ?? response.status)}`);
    return payload;
  }
}

function requireJoin(body: Record<string, unknown>): IdentityRuntimeJoin & { capabilityToken: string } {
  const projection = stringField(body, "projection");
  const projectionId = stringField(body, "projectionId");
  const stateHash = stringField(body, "stateHash");
  const leaseId = stringField(body, "leaseId");
  const capabilityToken = stringField(body, "capabilityToken");
  const expiresAt = numberField(body, "expiresAt");
  if (!projection || !projectionId || !stateHash || !leaseId || !capabilityToken || expiresAt === undefined) throw new Error("identity runtime returned invalid join response");
  return { projection, projectionId, stateHash, leaseId, expiresAt, capabilityToken };
}

function bearerToken(value: string | null): string | undefined {
  return value?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function isTransportPayload(value: unknown): value is { version: "v1"; operation: TransportOperation; body: Record<string, unknown> } {
  return isRecord(value) && value.version === "v1" && typeof value.operation === "string" && OPERATIONS.has(value.operation) && isRecord(value.body);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringField(body: Record<string, unknown>, key: string): string { return typeof body[key] === "string" ? body[key] : ""; }
function numberField(body: Record<string, unknown>, key: string): number | undefined { return typeof body[key] === "number" && Number.isFinite(body[key]) ? body[key] : undefined; }
function stringArrayField(body: Record<string, unknown>, key: string): string[] | undefined { return Array.isArray(body[key]) && body[key].every((value) => typeof value === "string") ? body[key] as string[] : undefined; }
function parseCompileRequest(value: unknown): ProjectionCompileRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.identity !== "string" || typeof value.surfaceId !== "string" || typeof value.message !== "string") return undefined;
  if (!(value.mode === "plan" || value.mode === "edit" || value.mode === "auto")) return undefined;
  if (value.cartridgeOverride !== undefined && value.cartridgeOverride !== null && typeof value.cartridgeOverride !== "string") return undefined;
  if (value.task !== undefined && typeof value.task !== "string") return undefined;
  if (value.hostContext !== undefined && (!Array.isArray(value.hostContext) || !value.hostContext.every((item) => typeof item === "string"))) return undefined;
  return {
    identity: value.identity,
    surfaceId: value.surfaceId,
    mode: value.mode,
    message: value.message,
    cartridgeOverride: value.cartridgeOverride as string | null | undefined,
    task: value.task as string | undefined,
    hostContext: value.hostContext as string[] | undefined,
  };
}

function parseRuntimeProjection(value: unknown): RuntimeProjection | undefined {
  if (!isRecord(value)) return undefined;
  const stringArray = (key: string): string[] | undefined => stringArrayField(value, key);
  const cartridgeVersions = value.cartridgeVersions;
  if (typeof value.prompt !== "string" || typeof value.promptStaticHash !== "string"
    || typeof value.kernelVersion !== "string" || typeof value.substrateViewVersion !== "string"
    || !isRecord(cartridgeVersions) || !stringArray("readScopes") || !stringArray("writeScopes")
    || !stringArray("proposalScopes") || !stringArray("declaredSubstrateScopes")
    || !(value.scopeDeclarationStatus === "implemented" || value.scopeDeclarationStatus === "unimplemented" || value.scopeDeclarationStatus === "none")) return undefined;
  if (!Object.values(cartridgeVersions).every((entry) => typeof entry === "string")) return undefined;
  return {
    prompt: value.prompt,
    promptStaticHash: value.promptStaticHash,
    kernelVersion: value.kernelVersion,
    cartridgeVersions: cartridgeVersions as Record<string, string>,
    substrateViewVersion: value.substrateViewVersion,
    readScopes: value.readScopes as RuntimeProjection["readScopes"],
    writeScopes: value.writeScopes as RuntimeProjection["writeScopes"],
    proposalScopes: value.proposalScopes as RuntimeProjection["proposalScopes"],
    declaredSubstrateScopes: value.declaredSubstrateScopes as RuntimeProjection["declaredSubstrateScopes"],
    scopeDeclarationStatus: value.scopeDeclarationStatus,
  };
}
const MEMORY_SCOPES: ReadonlySet<MemoryScope> = new Set(["episode", "fact", "observation", "scent", "preference", "private", "scar", "decision", "project", "heartwood", "growth_ring", "canopy", "identity", "narrative", "behavior", "skill", "relationship"]);
function isMemoryEntry(entry: Record<string, unknown>): entry is { scope: MemoryScope; content: string; tags: string[]; confidence: number; source: string; metadata?: Record<string, unknown> } {
  return typeof entry.scope === "string" && MEMORY_SCOPES.has(entry.scope as MemoryScope) && typeof entry.content === "string" && Array.isArray(entry.tags)
    && entry.tags.every((tag) => typeof tag === "string") && typeof entry.confidence === "number" && typeof entry.source === "string"
    && (entry.metadata === undefined || isRecord(entry.metadata));
}
function failure(status: number, error: string): TransportResponse { return { status, body: { error } }; }
