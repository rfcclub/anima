import type { AgentMemoryEntry, MemoryScope } from "../../../src/memory/contract.ts";
import { ConsolidateRejectedError, RoomCommitRejectedError } from "../../../src/identity-runtime/contract/remote-continuity.ts";
import {
  TenantIdentityRuntime,
  RuntimeDrainingError,
  type TenantConsolidateInput,
  type TenantRecallInput,
  type TenantRememberInput,
} from "./tenant-runtime.ts";
import {
  privateTenantRuntimeSecurity,
  type TenantRuntimeSecurity,
} from "./tenant-security.ts";

export {
  privateTenantRuntimeSecurity,
  type TenantRuntimeSecurity,
} from "./tenant-security.ts";

export function startTenantIdentityRuntimeHttp(
  runtime: TenantIdentityRuntime,
  host: string,
  port: number,
  security: TenantRuntimeSecurity = privateTenantRuntimeSecurity,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: host,
    port,
    fetch: async (request) => {
      if (!runtime.accepting) {
        return Response.json({ error: "identity runtime is draining" }, { status: 503 });
      }
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, runtime: "identity-runtime", ...runtime.health() });
      }
      if (request.method !== "POST") {
        return Response.json({ error: "method not allowed" }, { status: 405 });
      }
      if (!(await security.admit(request))) {
        return Response.json({ error: "admission denied" }, { status: 401 });
      }
      const body = await jsonBody(request);
      if (!body) return Response.json({ error: "invalid JSON" }, { status: 400 });

      const agentId = joinAgentId(url.pathname);
      try {
        if (agentId) {
          if (body.agentId !== undefined) {
            return Response.json({ error: "agentId belongs in the join path" }, { status: 400 });
          }
          return Response.json(await runtime.join(agentId, {
            clientId: stringField(body, "clientId"),
            surfaceId: stringField(body, "surfaceId"),
            message: stringField(body, "message"),
            cartridgeOverride: nullableStringField(body, "cartridgeOverride"),
            hostContext: optionalStringArray(body, "hostContext"),
            mesh: optionalMeshHint(body),
          }));
        }
        if (url.pathname === "/identity-runtime/continuity/mesh-proof") {
          if (body.notAfter !== undefined && typeof body.notAfter !== "number") throw new Error("mesh installation is invalid");
          return Response.json(await runtime.meshProof({
            leaseId: stringField(body, "leaseId"),
            clientId: stringField(body, "clientId"),
            sessionToken: stringField(body, "sessionToken"),
            ...(typeof body.notAfter === "number" ? { notAfter: body.notAfter } : {}),
          }));
        }
        if (url.pathname === "/identity-runtime/continuity/mesh/list") {
          return Response.json(await runtime.meshList({
            leaseId: stringField(body, "leaseId"),
            clientId: stringField(body, "clientId"),
            sessionToken: stringField(body, "sessionToken"),
          }));
        }
        if (url.pathname === "/identity-runtime/continuity/mesh/send") {
          const from = body.from;
          if (from !== undefined && typeof from !== "string") throw new Error("mesh from is invalid");
          return Response.json(await runtime.meshSend({
            leaseId: stringField(body, "leaseId"),
            clientId: stringField(body, "clientId"),
            sessionToken: stringField(body, "sessionToken"),
            target: typeof body.target === "string" ? body.target : "",
            content: typeof body.content === "string" ? body.content : "",
            messageId: typeof body.messageId === "string" ? body.messageId : "",
            ...(from !== undefined ? { from } : {}),
          }));
        }
        if (url.pathname === "/identity-runtime/continuity/remember") {
          if (body.agentId !== undefined) {
            return Response.json({ error: "agentId is not accepted after join" }, { status: 400 });
          }
          return Response.json(await runtime.remember(rememberInput(body)));
        }
        if (url.pathname === "/identity-runtime/continuity/consolidate") {
          const allowed = ["leaseId", "clientId", "sessionToken", "stateHash", "idempotencyKey", "batch"];
          if (body.agentId !== undefined || Object.keys(body).some(key => !allowed.includes(key))) {
            return Response.json({ error: "identity runtime consolidate input is invalid" }, { status: 400 });
          }
          return Response.json(await runtime.consolidate(consolidateInput(body)));
        }
        if (url.pathname === "/identity-runtime/continuity/recall") {
          if (body.agentId !== undefined) {
            return Response.json({ error: "agentId is not accepted after join" }, { status: 400 });
          }
          return Response.json(await runtime.recall(recallInput(body)));
        }
        if (url.pathname === "/identity-runtime/continuity/direct-recall") {
          if (body.agentId !== undefined) {
            return Response.json({ error: "agentId is not accepted after join" }, { status: 400 });
          }
          return Response.json(await runtime.directRecall({
            leaseId: stringField(body, "leaseId"),
            clientId: stringField(body, "clientId"),
            sessionToken: stringField(body, "sessionToken"),
            stateHash: stringField(body, "stateHash"),
            query: stringField(body, "query"),
          }));
        }
        if (url.pathname === "/identity-runtime/shared/commit-room") {
          const allowed = ["leaseId", "clientId", "sessionToken", "stateHash", "placeId", "conversationId", "requestKey", "text"];
          let input;
          try {
            if (Object.keys(body).some(key => !allowed.includes(key))) throw new Error();
            input = {
              leaseId: stringField(body, "leaseId"), clientId: stringField(body, "clientId"),
              sessionToken: stringField(body, "sessionToken"), stateHash: stringField(body, "stateHash"),
              placeId: stringField(body, "placeId"), conversationId: stringField(body, "conversationId"),
              requestKey: stringField(body, "requestKey"), text: stringField(body, "text"),
            };
          } catch { throw new RoomCommitRejectedError("shared room commit input is invalid"); }
          return Response.json(await runtime.commitRoom(input, request.signal));
        }
        if (url.pathname === "/identity-runtime/shared/read-room") {
          const allowed = ["leaseId", "clientId", "sessionToken", "stateHash", "placeId", "conversationId"];
          if (Object.keys(body).some(key => !allowed.includes(key))) {
            return Response.json({ error: "unsupported room-read field" }, { status: 400 });
          }
          return Response.json(await runtime.readRoom({
            leaseId: stringField(body, "leaseId"), clientId: stringField(body, "clientId"),
            sessionToken: stringField(body, "sessionToken"), stateHash: stringField(body, "stateHash"),
            placeId: stringField(body, "placeId"), conversationId: stringField(body, "conversationId"),
          }));
        }
        return Response.json({ error: "not found" }, { status: 404 });
      } catch (error) {
        if (url.pathname === "/identity-runtime/shared/commit-room") {
          return error instanceof RoomCommitRejectedError
            ? Response.json({ error: "shared room commit rejected", rejectedBeforeCommit: true }, { status: statusFor(error) })
            : Response.json({ error: "shared room commit outcome unknown" }, { status: 503 });
        }
        return Response.json(
          { error: error instanceof Error ? error.message : "runtime request failed" },
          { status: statusFor(error) },
        );
      }
    },
  });
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await request.json();
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function optionalMeshHint(body: Record<string, unknown>): { harness: string; cwd: string; machine: string; notAfter?: number } | undefined {
  const mesh = body.mesh;
  if (mesh === undefined) return undefined;
  if (!isRecord(mesh) || typeof mesh.harness !== "string" || typeof mesh.cwd !== "string" || typeof mesh.machine !== "string"
    || (mesh.notAfter !== undefined && typeof mesh.notAfter !== "number")) {
    throw new Error("mesh installation is invalid");
  }
  return { harness: mesh.harness, cwd: mesh.cwd, machine: mesh.machine, ...(mesh.notAfter !== undefined ? { notAfter: mesh.notAfter as number } : {}) };
}

function joinAgentId(pathname: string): string | undefined {
  const match = /^\/identity-runtime\/([^/]+)\/join$/.exec(pathname);
  return match?.[1];
}

function rememberInput(body: Record<string, unknown>): TenantRememberInput {
  const entry = body.entry;
  if (!isRecord(entry)) throw new Error("entry is required");
  return {
    leaseId: stringField(body, "leaseId"),
    clientId: stringField(body, "clientId"),
    sessionToken: stringField(body, "sessionToken"),
    stateHash: stringField(body, "stateHash"),
    idempotencyKey: stringField(body, "idempotencyKey"),
    entry: {
      scope: memoryScopeField(entry, "scope"),
      content: stringField(entry, "content"),
      tags: optionalStringArray(entry, "tags") ?? [],
      confidence: numberField(entry, "confidence") ?? 0.5,
      source: stringField(entry, "source"),
      metadata: isRecord(entry.metadata) ? entry.metadata : undefined,
    },
  };
}

const MEMORY_SCOPES: readonly MemoryScope[] = [
  "episode", "fact", "observation", "scent", "preference", "private",
  "scar", "decision", "project", "heartwood", "growth_ring", "canopy",
  "identity", "narrative", "behavior", "skill", "relationship",
];

function memoryScopeField(body: Record<string, unknown>, name: string): AgentMemoryEntry["scope"] {
  const value = stringField(body, name);
  if (!MEMORY_SCOPES.includes(value as MemoryScope)) {
    throw new Error(name + " is invalid");
  }
  return value as MemoryScope;
}

function consolidateInput(body: Record<string, unknown>): TenantConsolidateInput {
  const batch = body.batch;
  if (!isRecord(batch)) throw new ConsolidateRejectedError("remote consolidate batch is invalid");
  const candidates = batch.candidates;
  if (candidates !== undefined && !Array.isArray(candidates)) {
    throw new ConsolidateRejectedError("remote consolidate candidates are invalid");
  }
  return {
    leaseId: stringField(body, "leaseId"),
    clientId: stringField(body, "clientId"),
    sessionToken: stringField(body, "sessionToken"),
    stateHash: stringField(body, "stateHash"),
    idempotencyKey: stringField(body, "idempotencyKey"),
    batch: {
      sessionId: typeof batch.sessionId === "string" ? batch.sessionId : "",
      sequence: typeof batch.sequence === "number" ? batch.sequence : Number.NaN,
      summary: typeof batch.summary === "string" ? batch.summary : "",
      ...(candidates !== undefined ? {
        candidates: (candidates as unknown[]).map((candidate) => isRecord(candidate) ? {
          claim: typeof candidate.claim === "string" ? candidate.claim : "",
          evidence: typeof candidate.evidence === "string" ? candidate.evidence : "",
          confidence: typeof candidate.confidence === "number" ? candidate.confidence : Number.NaN,
        } : { claim: "", evidence: "", confidence: Number.NaN }),
      } : {}),
    },
  };
}

function recallInput(body: Record<string, unknown>): TenantRecallInput {
  return {
    leaseId: stringField(body, "leaseId"),
    clientId: stringField(body, "clientId"),
    sessionToken: stringField(body, "sessionToken"),
    stateHash: stringField(body, "stateHash"),
    query: stringField(body, "query"),
    substrateScope: stringField(body, "substrateScope"),
  };
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value) throw new Error(name + " is required");
  return value;
}

function nullableStringField(
  body: Record<string, unknown>,
  name: string,
): string | null | undefined {
  const value = body[name];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw new Error(name + " must be a string or null");
  return value;
}

function optionalStringArray(body: Record<string, unknown>, name: string): string[] | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(name + " must be a string array");
  }
  return value;
}

function numberField(body: Record<string, unknown>, name: string): number | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(name + " must be a number");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusFor(error: unknown): number {
  if (error instanceof RuntimeDrainingError) return 503;
  // A proven pre-write refusal (bad batch, over the cap, out of scope, stale
  // state) wrote nothing, so it is the client's to fix; a dead session or
  // expired lease is an admission failure.
  if (error instanceof ConsolidateRejectedError) {
    return error.message.includes("unavailable") ? 401 : 400;
  }
  if (!(error instanceof Error)) return 409;
  if (error.message.endsWith(" is invalid")) return 400;
  if (error.message === "sessionToken is required") return 401;
  if (error.message === "identity tenant is not registered") return 404;
  if (error.message === "mesh enrollment is not configured") return 404;
  if (error.message === "mesh send denied") return 403;
  if (error.message === "mesh is unavailable") return 503;
  if (error.message === "tenant direct recall is unavailable") return 404;
  if (error.message === "shared room read is unavailable") return 404;
  if (error.message === "shared room read is disabled") return 503;
  if (error.message === "shared room read denied") return 403;
  if (error.message === "shared room commit is unavailable") return 404;
  if (error.message === "shared room commit is disabled") return 503;
  if (error.message === "shared room speech denied") return 403;
  if (error.message === "runtime session is unavailable" || error.message === "lease is unavailable") {
    return 401;
  }
  return 409;
}
