import {
  RememberRejectedError,
  RoomCommitRejectedError,
  type ActiveJoinIntent,
  type RemoteContinuityPort,
  type RemoteRecallRequest,
  type RemoteRememberRequest,
} from "../../identity-runtime/contract/remote-continuity.ts";
import type { MemoryScope } from "../../memory/contract";

const ELI_COMPILE_PATH = "/internal/continuity/eli/compile";
const ELI_REMEMBER_PATH = "/internal/continuity/eli/remember";
const ELI_RECALL_PATH = "/internal/continuity/eli/recall";
const BRUNO_COMPILE_PATH = "/internal/continuity/bruno/compile";
const BRUNO_REMEMBER_PATH = "/internal/continuity/bruno/remember";
const BRUNO_RECALL_PATH = "/internal/continuity/bruno/recall";
const TENANT_CONTINUITY_PATH = /^\/internal\/continuity\/([^/]+)\/(compile|remember|recall|direct-recall|read-room|commit-room)$/;

export type TenantContinuityResolver = (
  agentId: string,
) => RemoteContinuityPort | undefined | Promise<RemoteContinuityPort | undefined>;

/**
 * Routes a registered identity's private ANIMA continuity boundary.
 * The path tenant is authoritative: a compile request may not select a
 * different identity in its JSON body.
 */
export async function handleTenantContinuityRequest(
  request: Request,
  resolveTenant: TenantContinuityResolver,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const route = TENANT_CONTINUITY_PATH.exec(url.pathname);
  if (!route) return json({ error: "not_found" }, 404);

  const service = await resolveTenant(route[1]);
  if (!service) return json({ error: "identity_not_registered" }, 404);
  const payload = await readJson(request);
  if (!payload) return json({ error: "invalid_json" }, 400);

  try {
    if (route[2] === "commit-room") {
      if (Object.keys(payload).some(key => !["grantId", "stateHash", "placeId", "conversationId", "requestKey", "text"].includes(key))) {
        throw new RoomCommitRejectedError("unsupported room-commit field");
      }
      if (!service.commitRoom) throw new RoomCommitRejectedError("shared room commit is unavailable");
      // Parsing errors are pre-delegation refusals; failures after delegation are ambiguous.
      let input;
      try {
        input = {
          grantId: stringField(payload, "grantId"), stateHash: stringField(payload, "stateHash"),
          placeId: stringField(payload, "placeId"), conversationId: stringField(payload, "conversationId"),
          requestKey: stringField(payload, "requestKey"), text: stringField(payload, "text"),
        };
      } catch { throw new RoomCommitRejectedError("shared room commit input is invalid"); }
      return json(await service.commitRoom(input, request.signal));
    }
    if (route[2] === "compile") {
      const intent = parseActiveJoinIntent(payload);
      if (intent.identity !== route[1]) {
        throw new Error("identity must match the continuity path");
      }
      return json(await service.compile(intent));
    }
    if (route[2] === "recall") {
      return json(await service.recall(parseRemoteRecall(payload)));
    }
    if (route[2] === "direct-recall") {
      if (!service.directRecall) return json({ error: "direct_recall_not_supported" }, 404);
      return json(await service.directRecall({
        grantId: stringField(payload, "grantId"),
        stateHash: stringField(payload, "stateHash"),
        query: stringField(payload, "query"),
      }));
    }
    if (route[2] === "read-room") {
      if (Object.keys(payload).some(key => !["grantId", "stateHash", "placeId", "conversationId"].includes(key))) {
        throw new Error("unsupported room-read field");
      }
      if (!service.readRoom) return json({ error: "shared room read is unavailable" }, 404);
      return json(await service.readRoom({
        grantId: stringField(payload, "grantId"), stateHash: stringField(payload, "stateHash"),
        placeId: stringField(payload, "placeId"), conversationId: stringField(payload, "conversationId"),
      }));
    }
    return json(await service.remember(parseRemoteRemember(payload)));
  } catch (error) {
    if (route[2] === "commit-room") {
      return error instanceof RoomCommitRejectedError
        ? json({ error: error.message, rejectedBeforeCommit: true }, 409)
        : json({ error: "shared room commit outcome unknown" }, 503);
    }
    return json(errorBody(error), 400);
  }
}

/** Routes one identity's internal Continuity boundary (eli or bruno). */
async function handleContinuityRequest(
  request: Request,
  service: RemoteContinuityPort,
  compilePath: string,
  rememberPath: string,
  recallPath: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (url.pathname !== compilePath && url.pathname !== rememberPath && url.pathname !== recallPath) {
    return json({ error: "not_found" }, 404);
  }
  const payload = await readJson(request);
  if (!payload) return json({ error: "invalid_json" }, 400);

  try {
    if (url.pathname === compilePath) {
      const result = await service.compile(parseActiveJoinIntent(payload));
      return json(result);
    }
    if (url.pathname === recallPath) {
      const result = await service.recall(parseRemoteRecall(payload));
      return json(result);
    }
    const result = await service.remember(parseRemoteRemember(payload));
    return json(result);
  } catch (error) {
    return json(errorBody(error), 400);
  }
}

/** Routes only ANIMA's internal Eli Continuity boundary. */
export function handleEliContinuityRequest(
  request: Request,
  service: RemoteContinuityPort,
): Promise<Response> {
  return handleContinuityRequest(request, service, ELI_COMPILE_PATH, ELI_REMEMBER_PATH, ELI_RECALL_PATH);
}

/** Routes only ANIMA's internal Bruno Continuity boundary. */
export function handleBrunoContinuityRequest(
  request: Request,
  service: RemoteContinuityPort,
): Promise<Response> {
  return handleContinuityRequest(request, service, BRUNO_COMPILE_PATH, BRUNO_REMEMBER_PATH, BRUNO_RECALL_PATH);
}

/** Only a proven pre-write remember refusal is flagged; the runtime treats every other failure as an unknown outcome. */
function errorBody(error: unknown): { error: string; rejectedBeforeWrite?: true } {
  const message = error instanceof Error ? error.message : "invalid_request";
  return error instanceof RememberRejectedError ? { error: message, rejectedBeforeWrite: true } : { error: message };
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await request.json();
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseActiveJoinIntent(value: Record<string, unknown>): ActiveJoinIntent {
  return {
    identity: stringField(value, "identity"),
    surfaceId: stringField(value, "surfaceId"),
    message: stringField(value, "message"),
    cartridgeOverride: optionalNullableString(value, "cartridgeOverride"),
    hostContext: optionalStringArray(value, "hostContext"),
  };
}

function parseRemoteRemember(value: Record<string, unknown>): RemoteRememberRequest {
  const entry = value.entry;
  if (!isRecord(entry)) throw new Error("remote remember entry is required");
  return {
    grantId: stringField(value, "grantId"),
    stateHash: stringField(value, "stateHash"),
    idempotencyKey: stringField(value, "idempotencyKey"),
    entry: {
      scope: memoryScopeField(entry, "scope"),
      content: stringField(entry, "content"),
      tags: optionalStringArray(entry, "tags") ?? [],
      confidence: typeof entry.confidence === "number" ? entry.confidence : 0.5,
      source: stringField(entry, "source"),
      metadata: isRecord(entry.metadata) ? entry.metadata : undefined,
    },
  };
}

function parseRemoteRecall(value: Record<string, unknown>): RemoteRecallRequest {
  return {
    grantId: stringField(value, "grantId"),
    stateHash: stringField(value, "stateHash"),
    query: stringField(value, "query"),
    substrateScope: stringField(value, "substrateScope"),
  };
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== "string") throw new Error(`${name} is required`);
  return field;
}

const MEMORY_SCOPES: readonly MemoryScope[] = [
  "episode", "fact", "observation", "scent", "preference", "private",
  "scar", "decision", "project", "heartwood", "growth_ring", "canopy",
  "identity", "narrative", "behavior", "skill", "relationship",
];

function memoryScopeField(value: Record<string, unknown>, name: string): MemoryScope {
  const field = stringField(value, name);
  if (!MEMORY_SCOPES.includes(field as MemoryScope)) throw new Error(`${name} is invalid`);
  return field as MemoryScope;
}

function optionalNullableString(value: Record<string, unknown>, name: string): string | null | undefined {
  const field = value[name];
  if (field === undefined || field === null) return field;
  if (typeof field !== "string") throw new Error(`${name} must be a string or null`);
  return field;
}

function optionalStringArray(value: Record<string, unknown>, name: string): string[] | undefined {
  const field = value[name];
  if (field === undefined) return undefined;
  if (!Array.isArray(field) || field.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a string array`);
  }
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
