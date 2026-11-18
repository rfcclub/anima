import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteContinuityPort } from "../../../src/identity-runtime/contract/remote-continuity.ts";
import { startBrunoRuntimeHttp } from "../src/http.ts";
import { BrunoRuntime } from "../src/runtime.ts";
import { uuidBearerSecurity } from "../../eli-runtime/src/security.ts";
import type { QueryClassifier, RecallSource } from "../src/recall-dispatcher.ts";

let root: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => { server?.stop(); server = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

class FakeClassifier implements QueryClassifier {
  constructor(private readonly sources: RecallSource[]) {}
  async classify(): Promise<RecallSource[]> {
    return this.sources;
  }
}

function createContinuity(): RemoteContinuityPort {
  return {
    compile: async () => ({
      projection: { prompt: "Bruno projection", promptStaticHash: "static", kernelVersion: "kernel", cartridgeVersions: {}, substrateViewVersion: "view", readScopes: [], writeScopes: ["scent"], proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "unimplemented" },
      grant: { grantId: "grant", identity: "bruno", surfaceId: "surface", projectionId: "projection", stateHash: "state", writeScopes: ["scent"], issuedAt: 1, expiresAt: 10_000 },
    }),
    remember: async () => ({ id: "memory", createdAt: "now" }),
    recall: async () => ({ resolution: { ok: false, requestedScope: "episodic_memory", diagnostic: { code: "undeclared_scope", message: "not declared" } }, results: [] }),
  };
}

test("serves a health proof and joins through the public incarnation boundary", async () => {
  root = mkdtempSync(join(tmpdir(), "bruno-runtime-http-"));
  const runtime = new BrunoRuntime({ dbPath: join(root, "runtime.db"), continuity: createContinuity(), now: () => 1 });
  server = startBrunoRuntimeHttp(runtime, "127.0.0.1", 0);
  const base = `http://${server.hostname}:${server.port}`;

  expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, identity: "bruno" });
  const joined = await fetch(`${base}/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "cli", surfaceId: "surface", message: "hello" }) });
  expect(await joined.json()).toMatchObject({ projection: "Bruno projection", stateHash: "state" });
  const wrongIdentity = await fetch(`${base}/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "eli", clientId: "cli", surfaceId: "surface", message: "hello" }) });
  expect(wrongIdentity.status).toBe(400);
  runtime.close();
});

test("optional UUID bearer wrapper rejects admission before join payload handling", async () => {
  root = mkdtempSync(join(tmpdir(), "bruno-runtime-http-"));
  const runtime = new BrunoRuntime({ dbPath: join(root, "runtime.db"), continuity: { compile: async () => { throw new Error("must not compile"); }, remember: async () => ({ id: "never", createdAt: "never" }), recall: async () => ({ resolution: { ok: false, requestedScope: "episodic_memory", diagnostic: { code: "undeclared_scope", message: "not declared" } }, results: [] }) } });
  server = startBrunoRuntimeHttp(runtime, "127.0.0.1", 0, uuidBearerSecurity("pilot-token"));
  const response = await fetch(`http://${server.hostname}:${server.port}/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(response.status).toBe(401);
  runtime.close();
});

describe("POST /v1/continuity/recall", () => {
  test("dispatches through the real recall-dispatcher, not a 409 stub", async () => {
    root = mkdtempSync(join(tmpdir(), "bruno-runtime-http-"));
    const runtime = new BrunoRuntime({ dbPath: join(root, "runtime.db"), continuity: createContinuity(), now: () => 1 });
    server = startBrunoRuntimeHttp(runtime, "127.0.0.1", 0, undefined, { classifier: new FakeClassifier(["bruno_entity"]) });
    const response = await fetch(`http://${server.hostname}:${server.port}/v1/continuity/recall`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "test" }),
    });
    expect(response.status).toBe(200);
    const results = await response.json();
    expect(Array.isArray(results)).toBe(true);
    expect(results[0].source).toBe("bruno_entity");
    runtime.close();
  });

  test("rejects a request with no query", async () => {
    root = mkdtempSync(join(tmpdir(), "bruno-runtime-http-"));
    const runtime = new BrunoRuntime({ dbPath: join(root, "runtime.db"), continuity: createContinuity(), now: () => 1 });
    server = startBrunoRuntimeHttp(runtime, "127.0.0.1", 0);
    const response = await fetch(`http://${server.hostname}:${server.port}/v1/continuity/recall`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(400);
    runtime.close();
  });
});
