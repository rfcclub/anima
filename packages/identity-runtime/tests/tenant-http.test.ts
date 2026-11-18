import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteContinuityPort } from "../../../src/identity-runtime/contract/remote-continuity.ts";
import { startTenantIdentityRuntimeHttp } from "../src/tenant-http.ts";
import { uuidBearerTenantSecurity } from "../src/tenant-security.ts";
import { TenantIdentityRuntime } from "../src/tenant-runtime.ts";

let root: string | undefined;
let server: ReturnType<typeof startTenantIdentityRuntimeHttp> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("tenant identity runtime HTTP", () => {
  test("admits Eli and Bruno only through their path-scoped join route", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-http-"));
    const eli = continuity("eli");
    const bruno = continuity("bruno");
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([
        ["eli", { continuity: eli }],
        ["bruno", { continuity: bruno }],
      ]),
      now: () => 100,
    });
    server = startTenantIdentityRuntimeHttp(runtime, "127.0.0.1", 0);
    const base = "http://" + server.hostname + ":" + server.port;

    const eliJoin = await fetch(base + "/identity-runtime/eli/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(joinBody()),
    });
    const brunoJoin = await fetch(base + "/identity-runtime/bruno/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(joinBody()),
    });
    const unknown = await fetch(base + "/identity-runtime/unknown/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(joinBody()),
    });
    const override = await fetch(base + "/identity-runtime/eli/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...joinBody(), agentId: "bruno" }),
    });

    expect(eliJoin.status).toBe(200);
    expect(brunoJoin.status).toBe(200);
    expect(unknown.status).toBe(404);
    expect(override.status).toBe(400);
    expect(eli.compileCalls).toBe(1);
    expect(bruno.compileCalls).toBe(1);
    runtime.close();
  });

  test("rejects post-join operations without the session token", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-http-"));
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["eli", { continuity: continuity("eli") }]]),
      now: () => 100,
    });
    server = startTenantIdentityRuntimeHttp(runtime, "127.0.0.1", 0);
    const base = "http://" + server.hostname + ":" + server.port;
    const joined = await (await fetch(base + "/identity-runtime/eli/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(joinBody()),
    })).json() as Record<string, string>;

    const response = await fetch(base + "/identity-runtime/continuity/recall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseId: joined.leaseId,
        clientId: "cli",
        stateHash: joined.stateHash,
        query: "what happened?",
        substrateScope: "episodic_memory",
      }),
    });

    expect(response.status).toBe(401);
    runtime.close();
  });

  test("rejects an invalid memory scope at the HTTP boundary", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-http-"));
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["eli", { continuity: continuity("eli") }]]),
      now: () => 100,
    });
    server = startTenantIdentityRuntimeHttp(runtime, "127.0.0.1", 0);
    const base = "http://" + server.hostname + ":" + server.port;
    const joined = await (await fetch(base + "/identity-runtime/eli/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(joinBody()),
    })).json() as Record<string, string>;

    const response = await fetch(base + "/identity-runtime/continuity/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseId: joined.leaseId,
        clientId: "cli",
        sessionToken: joined.sessionToken,
        stateHash: joined.stateHash,
        idempotencyKey: "invalid-scope",
        entry: {
          scope: "not-a-memory-scope",
          content: "note",
          source: "test",
        },
      }),
    });

    expect(response.status).toBe(400);
    runtime.close();
  });

  test("runs Bruno's direct recall policy through an authorized Bruno session only", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-http-"));
    const policyQueries: string[] = [];
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([
        ["eli", { continuity: continuity("eli") }],
        [
          "bruno",
          {
            continuity: continuity("bruno"),
            recallPolicy: {
              recall: async (query) => {
                policyQueries.push(query);
                return [{ source: "bruno_entity", content: "memory" }];
              },
            },
          },
        ],
      ]),
      now: () => 100,
    });
    server = startTenantIdentityRuntimeHttp(runtime, "127.0.0.1", 0);
    const base = "http://" + server.hostname + ":" + server.port;
    const eli = await joinTenant(base, "eli");
    const bruno = await joinTenant(base, "bruno");

    const brunoResponse = await fetch(base + "/identity-runtime/continuity/direct-recall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseId: bruno.leaseId,
        clientId: "cli",
        sessionToken: bruno.sessionToken,
        stateHash: bruno.stateHash,
        query: "what did I decide?",
      }),
    });
    const eliResponse = await fetch(base + "/identity-runtime/continuity/direct-recall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseId: eli.leaseId,
        clientId: "cli",
        sessionToken: eli.sessionToken,
        stateHash: eli.stateHash,
        query: "what did I decide?",
      }),
    });

    expect(brunoResponse.status).toBe(200);
    await expect(brunoResponse.json()).resolves.toEqual([{ source: "bruno_entity", content: "memory" }]);
    expect(eliResponse.status).toBe(404);
    expect(policyQueries).toEqual(["what did I decide?"]);
    runtime.close();
  });

  test("direct-recall over HTTP requires a stateHash and refuses a stale one", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-http-"));
    const policyQueries: string[] = [];
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([
        ["bruno", {
          continuity: continuity("bruno"),
          recallPolicy: { recall: async (query) => { policyQueries.push(query); return []; } },
        }],
      ]),
      now: () => 100,
    });
    server = startTenantIdentityRuntimeHttp(runtime, "127.0.0.1", 0);
    const base = "http://" + server.hostname + ":" + server.port;
    const bruno = await joinTenant(base, "bruno");
    const call = (extra: Record<string, unknown>) => fetch(base + "/identity-runtime/continuity/direct-recall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId: bruno.leaseId, clientId: "cli", sessionToken: bruno.sessionToken, query: "q", ...extra }),
    });

    const missing = await call({});
    expect(missing.status).toBe(409); // same as recall/remember: "<field> is required" maps to 409
    await expect(missing.json()).resolves.toEqual({ error: "stateHash is required" });
    const stale = await call({ stateHash: "stale" });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    await expect(stale.json()).resolves.toEqual({ error: "direct-recall stateHash is stale" });
    expect(policyQueries).toEqual([]);
    runtime.close();
  });

  test("optional UUID bearer admission rejects before any tenant compiler runs", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-http-"));
    const eli = continuity("eli");
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["eli", { continuity: eli }]]),
      now: () => 100,
    });
    server = startTenantIdentityRuntimeHttp(
      runtime,
      "127.0.0.1",
      0,
      uuidBearerTenantSecurity("pilot-token"),
    );
    const base = "http://" + server.hostname + ":" + server.port;

    const response = await fetch(base + "/identity-runtime/eli/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(joinBody()),
    });

    expect(response.status).toBe(401);
    expect(eli.compileCalls).toBe(0);
    runtime.close();
  });

  // /health used to report only {ok, runtime}, so diagnosing a stuck
  // tenant needed hand-written probes against the DB.
  test("GET /health reports per-tenant status with no auth required", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-http-"));
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([
        ["eli", { continuity: continuity("eli") }],
        ["bruno", { continuity: continuity("bruno") }],
      ]),
      now: () => 100,
    });
    server = startTenantIdentityRuntimeHttp(runtime, "127.0.0.1", 0, uuidBearerTenantSecurity("pilot-token"));
    const base = "http://" + server.hostname + ":" + server.port;

    const response = await fetch(base + "/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      runtime: "identity-runtime",
      tenants: [
        { agentId: "eli", pendingMutations: 0 },
        { agentId: "bruno", pendingMutations: 0 },
      ],
    });
    runtime.close();
  });
});

function joinBody() {
  return { clientId: "cli", surfaceId: "surface", message: "hello" };
}

async function joinTenant(base: string, agentId: string): Promise<Record<string, string>> {
  return (await (await fetch(base + "/identity-runtime/" + agentId + "/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(joinBody()),
  })).json()) as Record<string, string>;
}

function continuity(identity: string): RemoteContinuityPort & { compileCalls: number } {
  let compileCalls = 0;
  return {
    get compileCalls() {
      return compileCalls;
    },
    compile: async (input) => {
      compileCalls += 1;
      return {
        projection: {
          prompt: identity + " projection",
          promptStaticHash: "static",
          kernelVersion: "kernel",
          cartridgeVersions: {},
          substrateViewVersion: "view",
          readScopes: ["episode", "observation"],
          writeScopes: ["scent"],
          proposalScopes: [],
          declaredSubstrateScopes: ["episodic_memory"],
          scopeDeclarationStatus: "implemented" as const,
        },
        grant: {
          grantId: identity + "-grant",
          identity,
          surfaceId: input.surfaceId,
          projectionId: identity + "-projection",
          stateHash: identity + "-state",
          writeScopes: ["scent"],
          readScopes: ["episode", "observation"],
          declaredSubstrateScopes: ["episodic_memory"],
          scopeDeclarationStatus: "implemented" as const,
          issuedAt: 1,
          expiresAt: 1_000_000,
        },
      };
    },
    remember: async () => ({ id: "memory", createdAt: "now" }),
    recall: async () => ({
      resolution: {
        ok: true as const,
        requestedScope: "episodic_memory",
        memoryScopes: ["episode", "observation"],
      },
      results: [],
    }),
  };
}

describe("tenant identity runtime HTTP Mesh enrollment", () => {
  function meshPort() {
    return {
      enroll: async (agentId: string) => ({ status: "enrolled" as const, meshId: `${agentId}-omp-x@mac`, leaseExpiresAt: 9, heartbeatCredential: "hb-secret-credential" }),
      proof: (agentId: string) => `proof-secret-for-${agentId}`,
    };
  }

  test("passes join installation metadata through and issues a fresh proof only to a valid session, without logging secrets", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-http-mesh-"));
    const lines: string[] = [];
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["eli", { continuity: continuity("eli") }]]),
      now: () => 100,
      meshEnrollment: meshPort(),
      log: (level, msg, fields) => { lines.push(JSON.stringify({ level, msg, ...fields })); },
    });
    server = startTenantIdentityRuntimeHttp(runtime, "127.0.0.1", 0);
    const base = "http://" + server.hostname + ":" + server.port;
    const joined = await (await fetch(base + "/identity-runtime/eli/join", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...joinBody(), mesh: { harness: "omp", cwd: "/work/eli", machine: "mac" } }),
    })).json() as Record<string, any>;
    expect(joined.meshEnrollment).toEqual({ status: "enrolled", meshId: "eli-omp-x@mac", leaseExpiresAt: 9, heartbeatCredential: "hb-secret-credential" });
    // A numeric deadline is accepted; anything else is invalid installation metadata.
    const withDeadline = await fetch(base + "/identity-runtime/eli/join", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...joinBody(), mesh: { harness: "omp", cwd: "/work/eli", machine: "mac", notAfter: 1_000 } }),
    });
    expect(withDeadline.status).toBe(200);
    const badDeadline = await fetch(base + "/identity-runtime/eli/join", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...joinBody(), mesh: { harness: "omp", cwd: "/work/eli", machine: "mac", notAfter: "soon" } }),
    });
    expect(badDeadline.status).toBe(400);

    const proofFor = (sessionToken: string) => fetch(base + "/identity-runtime/continuity/mesh-proof", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId: joined.leaseId, clientId: "cli", sessionToken }),
    });
    const issued = await proofFor(joined.sessionToken);
    expect(issued.status).toBe(200);
    expect(await issued.json()).toEqual({ proof: "proof-secret-for-eli" });
    expect((await proofFor("wrong-token")).status).toBe(401);
    expect(lines.join("\n")).not.toContain("proof-secret");
    expect(lines.join("\n")).not.toContain("hb-secret-credential");
    runtime.close();
  });

  test("answers mesh-proof with 404 when Mesh enrollment is not configured", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-http-mesh-off-"));
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["eli", { continuity: continuity("eli") }]]),
      now: () => 100,
    });
    server = startTenantIdentityRuntimeHttp(runtime, "127.0.0.1", 0);
    const base = "http://" + server.hostname + ":" + server.port;
    const joined = await joinTenant(base, "eli");
    const response = await fetch(base + "/identity-runtime/continuity/mesh-proof", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId: joined.leaseId, clientId: "cli", sessionToken: joined.sessionToken }),
    });
    expect(response.status).toBe(404);
    runtime.close();
  });
});

describe("tenant identity runtime HTTP Mesh send and list", () => {
  function sendingPort(behaviour: (input: { target: string }) => unknown = () => ({ results: { "bruno-claude-1@mac": { status: "accepted", conversationId: "c1" } } })) {
    const calls: Array<{ op: string; agentId: string; input?: unknown }> = [];
    return {
      calls,
      port: {
        enroll: async () => ({ status: "pending" as const, retryable: true as const }),
        proof: () => "proof-secret",
        list: async (agentId: string) => { calls.push({ op: "list", agentId }); return { "bruno-claude-1@mac": { cwd: "/work/anima", harness: "claude", status: "online" } }; },
        send: async (agentId: string, input: { target: string }) => {
          calls.push({ op: "send", agentId, input });
          const result = behaviour(input);
          if (result instanceof Error) throw result;
          return result;
        },
      },
    };
  }

  async function started(port?: ReturnType<typeof sendingPort>["port"]) {
    root = mkdtempSync(join(tmpdir(), "tenant-http-mesh-send-"));
    const lines: string[] = [];
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["eli", { continuity: continuity("eli") }]]),
      now: () => 100,
      ...(port ? { meshEnrollment: port } : {}),
      log: (level, msg, fields) => { lines.push(JSON.stringify({ level, msg, ...fields })); },
    });
    server = startTenantIdentityRuntimeHttp(runtime, "127.0.0.1", 0);
    const base = "http://" + server.hostname + ":" + server.port;
    const joined = await joinTenant(base, "eli");
    const post = (path: string, extra: Record<string, unknown>, sessionToken = joined.sessionToken) => fetch(base + "/identity-runtime/continuity/mesh/" + path, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId: joined.leaseId, clientId: "cli", sessionToken, ...extra }),
    });
    return { runtime, lines, post };
  }

  test("IMS-1/IMS-3 sends and lists for the session's own agent and returns Mesh's answer", async () => {
    const { calls, port } = sendingPort();
    const { runtime, post } = await started(port);
    const sent = await post("send", { target: "bruno-claude-1@mac", content: "please review", messageId: "m1", from: "eli-codex-1@mac" });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ results: { "bruno-claude-1@mac": { status: "accepted", conversationId: "c1" } } });
    const listed = await post("list", {});
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ "bruno-claude-1@mac": { cwd: "/work/anima", harness: "claude", status: "online" } });
    expect(calls).toEqual([
      { op: "send", agentId: "eli", input: { target: "bruno-claude-1@mac", content: "please review", messageId: "m1", from: "eli-codex-1@mac" } },
      { op: "list", agentId: "eli" },
    ]);
    runtime.close();
  });

  test("IMS-4 refuses a wrong session token before calling Mesh", async () => {
    const { calls, port } = sendingPort();
    const { runtime, post } = await started(port);
    expect((await post("send", { target: "bruno-1@mac", content: "x", messageId: "m1" }, "wrong-token")).status).toBe(401);
    expect((await post("list", {}, "wrong-token")).status).toBe(401);
    expect(calls).toEqual([]);
    runtime.close();
  });

  test("IMS-5 answers 404 for both routes when Mesh is not configured", async () => {
    const { runtime, post } = await started();
    expect((await post("send", { target: "bruno-1@mac", content: "x", messageId: "m1" })).status).toBe(404);
    expect((await post("list", {})).status).toBe(404);
    runtime.close();
  });

  test("IMS-6/IMS-7 maps an invalid target to 400, a Mesh refusal to 403 and an outage to 503", async () => {
    const { port } = sendingPort((input) => input.target === "bruno" ? new Error("mesh target is invalid")
      : input.target === "denied-1@mac" ? new Error("mesh send denied") : new Error("mesh is unavailable"));
    const { runtime, post } = await started(port);
    expect((await post("send", { target: "bruno", content: "x", messageId: "m1" })).status).toBe(400);
    expect((await post("send", { target: "denied-1@mac", content: "x", messageId: "m2" })).status).toBe(403);
    expect((await post("send", { target: "down-1@mac", content: "x", messageId: "m3" })).status).toBe(503);
    expect((await post("send", { target: "bruno-1@mac", messageId: "m4" })).status).toBe(400);
    runtime.close();
  });

  test("IMS-8 never logs the message content", async () => {
    const { port } = sendingPort();
    const { runtime, lines, post } = await started(port);
    await post("send", { target: "bruno-claude-1@mac", content: "secret-content-xyz", messageId: "m1" });
    expect(lines.join("\n")).not.toContain("secret-content-xyz");
    expect(lines.join("\n")).toContain("mesh-send");
    runtime.close();
  });
});
