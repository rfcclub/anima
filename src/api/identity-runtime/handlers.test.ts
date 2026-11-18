import { describe, expect, test } from "bun:test";
import { RememberRejectedError, type RemoteContinuityPort } from "../../identity-runtime/contract/remote-continuity.ts";
import {
  handleBrunoContinuityRequest,
  handleEliContinuityRequest,
  handleTenantContinuityRequest,
} from "./handlers";

const service: RemoteContinuityPort = {
  compile: async () => ({
    projection: {
      prompt: "Eli projection",
      promptStaticHash: "static-1",
      kernelVersion: "kernel-1",
      cartridgeVersions: {},
      substrateViewVersion: "view-1",
      readScopes: [],
      writeScopes: ["scent"],
      proposalScopes: [],
      declaredSubstrateScopes: [],
      scopeDeclarationStatus: "unimplemented",
    },
    grant: {
      grantId: "grant-1", identity: "eli", surfaceId: "windows-codex",
      projectionId: "projection-1", stateHash: "state-1", writeScopes: ["scent"],
      issuedAt: 1_000, expiresAt: 2_000,
    },
  }),
  remember: async () => ({ id: "memory-1", createdAt: "2026-07-17T00:00:00.000Z" }),
  recall: async () => ({
    resolution: { ok: true, requestedScope: "episodic_memory", memoryScopes: ["episode", "observation"] },
    results: [],
  }),
};

describe("Eli Continuity HTTP handlers", () => {
  test("compiles only the Eli active-client intent", async () => {
    const response = await handleEliContinuityRequest(new Request("http://anima/internal/continuity/eli/compile", {
      method: "POST",
      body: JSON.stringify({ identity: "eli", surfaceId: "windows-codex", message: "Review." }),
    }), service);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      projection: { prompt: "Eli projection" },
      grant: { grantId: "grant-1" },
    });
  });

  test("dispatches recall and rejects malformed payloads and non-internal paths", async () => {
    const recalled = await handleEliContinuityRequest(new Request("http://anima/internal/continuity/eli/recall", {
      method: "POST",
      body: JSON.stringify({ grantId: "grant-1", stateHash: "state-1", query: "what happened?", substrateScope: "episodic_memory" }),
    }), service);
    expect(recalled.status).toBe(200);
    await expect(recalled.json()).resolves.toMatchObject({
      resolution: { ok: true, requestedScope: "episodic_memory" },
    });

    const malformed = await handleEliContinuityRequest(new Request("http://anima/internal/continuity/eli/compile", {
      method: "POST",
      body: "not json",
    }), service);
    expect(malformed.status).toBe(400);

    const missing = await handleEliContinuityRequest(new Request("http://anima/internal/continuity/eli/not-a-route", {
      method: "POST",
      body: "{}",
    }), service);
    expect(missing.status).toBe(404);
  });
});

describe("Bruno Continuity HTTP handlers", () => {
  const brunoService: RemoteContinuityPort = {
    compile: async () => ({
      projection: {
        prompt: "Bruno projection",
        promptStaticHash: "static-1",
        kernelVersion: "kernel-1",
        cartridgeVersions: {},
        substrateViewVersion: "view-1",
        readScopes: [],
        writeScopes: ["scent"],
        proposalScopes: [],
        declaredSubstrateScopes: [],
        scopeDeclarationStatus: "unimplemented",
      },
      grant: {
        grantId: "grant-1", identity: "bruno", surfaceId: "cli-session",
        projectionId: "projection-1", stateHash: "state-1", writeScopes: ["scent"],
        issuedAt: 1_000, expiresAt: 2_000,
      },
    }),
    remember: async () => ({ id: "memory-1", createdAt: "2026-08-14T00:00:00.000Z" }),
    recall: async () => ({ resolution: { ok: false, requestedScope: "episodic_memory", diagnostic: { code: "undeclared_scope", message: "not declared" } }, results: [] }),
  };

  test("compiles only the Bruno active-client intent through the bruno paths", async () => {
    const response = await handleBrunoContinuityRequest(new Request("http://anima/internal/continuity/bruno/compile", {
      method: "POST",
      body: JSON.stringify({ identity: "bruno", surfaceId: "cli-session", message: "Recall." }),
    }), brunoService);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      projection: { prompt: "Bruno projection" },
      grant: { grantId: "grant-1" },
    });
  });

  // SC-003: only a proven pre-write refusal is flagged, so the runtime knows it
  // may release its pending row; any other failure stays an unknown outcome.
  test("flags a pre-write remember refusal with rejectedBeforeWrite and nothing else", async () => {
    const remember = (error: Error) => handleBrunoContinuityRequest(new Request("http://anima/internal/continuity/bruno/remember", {
      method: "POST",
      body: JSON.stringify({
        grantId: "grant-1", stateHash: "state-1", idempotencyKey: "k",
        entry: { scope: "scent", content: "x", tags: [], confidence: 1, source: "test" },
      }),
    }), { ...brunoService, remember: async () => { throw error; } });

    const refused = await remember(new RememberRejectedError("remote remember stateHash is stale"));
    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toEqual({
      error: "remote remember stateHash is stale",
      rejectedBeforeWrite: true,
    });

    const unknown = await remember(new Error("disk full"));
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toEqual({ error: "disk full" });
  });

  test("rejects non-bruno paths — eli's handler and bruno's handler do not cross over", async () => {
    const viaBruno = await handleBrunoContinuityRequest(new Request("http://anima/internal/continuity/eli/compile", {
      method: "POST",
      body: JSON.stringify({ identity: "bruno", surfaceId: "cli-session", message: "Recall." }),
    }), brunoService);
    expect(viaBruno.status).toBe(404);

    const viaEli = await handleEliContinuityRequest(new Request("http://anima/internal/continuity/bruno/compile", {
      method: "POST",
      body: JSON.stringify({ identity: "eli", surfaceId: "windows-codex", message: "Review." }),
    }), service);
    expect(viaEli.status).toBe(404);
  });
});

describe("Tenant Continuity HTTP handler: direct recall", () => {
  const post = (tenant: string, service: RemoteContinuityPort | undefined) => handleTenantContinuityRequest(
    new Request(`http://anima/internal/continuity/${tenant}/direct-recall`, {
      method: "POST",
      body: JSON.stringify({ grantId: "g", stateHash: "s", query: "what did I decide?" }),
    }),
    async () => service,
  );

  test("routes to the tenant's directRecall with only grant, stateHash and query", async () => {
    const seen: unknown[] = [];
    const response = await post("abel", { ...service, directRecall: async (r) => { seen.push(r); return [{ source: "memory", content: "hit" }]; } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ source: "memory", content: "hit" }]);
    expect(seen).toEqual([{ grantId: "g", stateHash: "s", query: "what did I decide?" }]);
  });

  test("a tenant without direct recall answers 404 rather than 500", async () => {
    expect((await post("abel", service)).status).toBe(404);
  });
});

describe("Tenant Continuity HTTP handler", () => {
  test("selects the registered tenant from the path and rejects a mismatched compile identity", async () => {
    const eliCalls: string[] = [];
    const eli: RemoteContinuityPort = {
      ...service,
      compile: async (input) => {
        eliCalls.push(input.identity);
        return service.compile(input);
      },
    };
    const resolved: string[] = [];
    const resolve = async (agentId: string): Promise<RemoteContinuityPort | undefined> => {
      resolved.push(agentId);
      return agentId === "eli" ? eli : undefined;
    };

    const accepted = await handleTenantContinuityRequest(new Request(
      "http://anima/internal/continuity/eli/compile",
      {
        method: "POST",
        body: JSON.stringify({ identity: "eli", surfaceId: "windows-codex", message: "Review." }),
      },
    ), resolve);
    const mismatched = await handleTenantContinuityRequest(new Request(
      "http://anima/internal/continuity/eli/compile",
      {
        method: "POST",
        body: JSON.stringify({ identity: "bruno", surfaceId: "windows-codex", message: "Review." }),
      },
    ), resolve);
    const unknown = await handleTenantContinuityRequest(new Request(
      "http://anima/internal/continuity/unknown/recall",
      {
        method: "POST",
        body: JSON.stringify({ grantId: "grant-1", stateHash: "state-1", query: "hi", substrateScope: "episodic_memory" }),
      },
    ), resolve);

    expect(accepted.status).toBe(200);
    expect(mismatched.status).toBe(400);
    expect(unknown.status).toBe(404);
    expect(eliCalls).toEqual(["eli"]);
    expect(resolved).toEqual(["eli", "eli", "unknown"]);
  });
});
