import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteContinuityPort } from "../../../src/identity-runtime/contract/remote-continuity.ts";
import { startEliRuntimeHttp } from "../src/http.ts";
import { EliRuntime } from "../src/runtime.ts";
import { uuidBearerSecurity } from "../src/security.ts";

let root: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => { server?.stop(); server = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

test("serves a health proof and joins through the public incarnation boundary", async () => {
  root = mkdtempSync(join(tmpdir(), "eli-runtime-http-"));
  const continuity: RemoteContinuityPort = {
    compile: async () => ({
      projection: { prompt: "Eli projection", promptStaticHash: "static", kernelVersion: "kernel", cartridgeVersions: {}, substrateViewVersion: "view", readScopes: [], writeScopes: ["scent"], proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "unimplemented" },
      grant: { grantId: "grant", identity: "eli", surfaceId: "surface", projectionId: "projection", stateHash: "state", writeScopes: ["scent"], issuedAt: 1, expiresAt: 10_000 },
    }),
    remember: async () => ({ id: "memory", createdAt: "now" }),
    recall: async () => ({ resolution: { ok: false, requestedScope: "episodic_memory", diagnostic: { code: "undeclared_scope", message: "not declared" } }, results: [] }),
  };
  const runtime = new EliRuntime({ dbPath: join(root, "runtime.db"), continuity, now: () => 1 });
  server = startEliRuntimeHttp(runtime, "127.0.0.1", 0);
  const base = `http://${server.hostname}:${server.port}`;

  expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, identity: "eli" });
  const joined = await fetch(`${base}/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "windows", surfaceId: "surface", message: "hello" }) });
  expect(await joined.json()).toMatchObject({ projection: "Eli projection", stateHash: "state" });
  const wrongIdentity = await fetch(`${base}/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "bruno", clientId: "windows", surfaceId: "surface", message: "hello" }) });
  expect(wrongIdentity.status).toBe(400);
  runtime.close();
});

test("serves an authorized recall through the public incarnation boundary", async () => {
  root = mkdtempSync(join(tmpdir(), "eli-runtime-http-"));
  const continuity: RemoteContinuityPort = {
    compile: async () => ({
      projection: { prompt: "Eli projection", promptStaticHash: "static", kernelVersion: "kernel", cartridgeVersions: {}, substrateViewVersion: "view", readScopes: ["episode", "observation"], writeScopes: ["scent"], proposalScopes: [], declaredSubstrateScopes: ["episodic_memory"], scopeDeclarationStatus: "implemented" },
      grant: { grantId: "grant", identity: "eli", surfaceId: "surface", projectionId: "projection", stateHash: "state", writeScopes: ["scent"], readScopes: ["episode", "observation"], declaredSubstrateScopes: ["episodic_memory"], scopeDeclarationStatus: "implemented", issuedAt: 1, expiresAt: 10_000 },
    }),
    remember: async () => ({ id: "memory", createdAt: "now" }),
    recall: async (request) => ({
      resolution: { ok: true, requestedScope: request.substrateScope, memoryScopes: ["episode", "observation"] },
      results: [{ id: "memory", content: request.query, scope: "episode", tags: [], confidence: 1, source: "test", createdAt: "now" }],
    }),
  };
  const runtime = new EliRuntime({ dbPath: join(root, "runtime.db"), continuity, now: () => 1 });
  server = startEliRuntimeHttp(runtime, "127.0.0.1", 0);
  const base = `http://${server.hostname}:${server.port}`;
  const joined = await (await fetch(`${base}/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "windows", surfaceId: "surface", message: "hello" }) })).json() as Record<string, string>;

  const response = await fetch(`${base}/v1/continuity/recall`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leaseId: joined.leaseId, clientId: "windows", capabilityToken: joined.capabilityToken, stateHash: joined.stateHash, query: "remembered", substrateScope: "episodic_memory" }),
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    resolution: { ok: true, requestedScope: "episodic_memory", memoryScopes: ["episode", "observation"] },
    results: [{ id: "memory", content: "remembered", scope: "episode", tags: [], confidence: 1, source: "test", createdAt: "now" }],
  });
  runtime.close();
});

test("optional UUID bearer wrapper rejects admission before join payload handling", async () => {
  root = mkdtempSync(join(tmpdir(), "eli-runtime-http-"));
  const runtime = new EliRuntime({ dbPath: join(root, "runtime.db"), continuity: { compile: async () => { throw new Error("must not compile"); }, remember: async () => ({ id: "never", createdAt: "never" }), recall: async () => ({ resolution: { ok: false, requestedScope: "episodic_memory", diagnostic: { code: "undeclared_scope", message: "not declared" } }, results: [] }) } });
  server = startEliRuntimeHttp(runtime, "127.0.0.1", 0, uuidBearerSecurity("pilot-token"));
  const response = await fetch(`http://${server.hostname}:${server.port}/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(response.status).toBe(401);
  runtime.close();
});
