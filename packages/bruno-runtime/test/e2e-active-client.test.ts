import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleBrunoContinuityRequest } from "../../../src/api/identity-runtime/handlers.ts";
import { HttpBrunoContinuityClient } from "../src/anima-continuity-client.ts";
import { startBrunoRuntimeHttp } from "../src/http.ts";
import { BrunoRuntime } from "../src/runtime.ts";
import type { RemoteContinuityPort } from "../../identity-runtime/src/index.js";

let root: string | undefined;
let anima: ReturnType<typeof Bun.serve> | undefined;
let incarnation: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => { anima?.stop(); incarnation?.stop(); anima = undefined; incarnation = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

// Mirrors packages/eli-runtime/tests/e2e-active-client.test.ts: a real
// ANIMA-shaped HTTP boundary (the actual handler, an injected service —
// the full createBrunoContinuityService with real AgentLoader/compiler/
// store is exercised in the live smoke test, not in this unit e2e) + the
// real bruno-runtime over its real HTTP client. Proves the runtime cannot
// and does not compile or write anything itself — everything flows through
// ANIMA's /internal/continuity/bruno/* boundary.
test("active client joins through ANIMA's bruno ContinuityService then writes through its lease", async () => {
  root = mkdtempSync(join(tmpdir(), "bruno-e2e-"));
  const service: RemoteContinuityPort = {
    compile: async () => ({ projection: { prompt: "Bruno canonical projection", promptStaticHash: "static", kernelVersion: "kernel", cartridgeVersions: {}, substrateViewVersion: "view", readScopes: [], writeScopes: ["scent"], proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "unimplemented" as const }, grant: { grantId: "grant", identity: "bruno", surfaceId: "surface", projectionId: "projection", stateHash: "state", writeScopes: ["scent"], issuedAt: 1, expiresAt: 2_000 } }),
    remember: async () => ({ id: "memory", createdAt: "now" }),
    recall: async () => ({ resolution: { ok: false, requestedScope: "episodic_memory", diagnostic: { code: "undeclared_scope", message: "not declared" } }, results: [] }),
  };
  anima = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handleBrunoContinuityRequest(request, service) });
  const runtime = new BrunoRuntime({ dbPath: join(root, "runtime.db"), continuity: new HttpBrunoContinuityClient(`http://${anima.hostname}:${anima.port}`), now: () => 1 });
  incarnation = startBrunoRuntimeHttp(runtime, "127.0.0.1", 0);
  const base = `http://${incarnation.hostname}:${incarnation.port}`;
  const joined = await (await fetch(`${base}/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "cli", surfaceId: "surface", message: "hello" }) })).json() as Record<string, unknown>;
  expect(joined.projection).toBe("Bruno canonical projection");
  const remembered = await fetch(`${base}/v1/continuity/remember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseId: joined.leaseId, clientId: "cli", capabilityToken: joined.capabilityToken, stateHash: joined.stateHash, idempotencyKey: "remember", entry: { scope: "scent", content: "e2e", tags: [], confidence: 1, source: "test" } }) });
  expect(await remembered.json()).toEqual({ id: "memory", createdAt: "now" });
  runtime.close();
});
