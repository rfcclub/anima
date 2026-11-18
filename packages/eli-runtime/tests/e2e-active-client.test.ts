import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleEliContinuityRequest } from "../../../src/api/identity-runtime/handlers.ts";
import { HttpAnimaContinuityClient } from "../src/anima-continuity-client.ts";
import { startEliRuntimeHttp } from "../src/http.ts";
import { EliRuntime } from "../src/runtime.ts";

let root: string | undefined;
let anima: ReturnType<typeof Bun.serve> | undefined;
let incarnation: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => { anima?.stop(); incarnation?.stop(); anima = undefined; incarnation = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

test("active client joins through HTTP ContinuityService then writes through its lease", async () => {
  root = mkdtempSync(join(tmpdir(), "eli-e2e-"));
  const service = {
    compile: async () => ({ projection: { prompt: "Eli canonical projection", promptStaticHash: "static", kernelVersion: "kernel", cartridgeVersions: {}, substrateViewVersion: "view", readScopes: ["episode", "observation"], writeScopes: ["scent"], proposalScopes: [], declaredSubstrateScopes: ["episodic_memory"], scopeDeclarationStatus: "implemented" as const }, grant: { grantId: "grant", identity: "eli", surfaceId: "surface", projectionId: "projection", stateHash: "state", writeScopes: ["scent"], readScopes: ["episode", "observation"], declaredSubstrateScopes: ["episodic_memory"], scopeDeclarationStatus: "implemented" as const, issuedAt: 1, expiresAt: 2_000 } }),
    remember: async () => ({ id: "memory", createdAt: "now" }),
    recall: async (request: { query: string; substrateScope: string }) => ({
      resolution: { ok: true, requestedScope: request.substrateScope, memoryScopes: ["episode", "observation"] },
      results: [{ id: "memory", content: request.query, scope: "episode", tags: [], confidence: 1, source: "test", createdAt: "now" }],
    }),
  };
  anima = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handleEliContinuityRequest(request, service) });
  const runtime = new EliRuntime({ dbPath: join(root, "runtime.db"), continuity: new HttpAnimaContinuityClient(`http://${anima.hostname}:${anima.port}`), now: () => 1 });
  incarnation = startEliRuntimeHttp(runtime, "127.0.0.1", 0);
  const base = `http://${incarnation.hostname}:${incarnation.port}`;
  const joined = await (await fetch(`${base}/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "windows", surfaceId: "surface", message: "hello" }) })).json() as Record<string, unknown>;
  expect(joined.projection).toBe("Eli canonical projection");
  const remembered = await fetch(`${base}/v1/continuity/remember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseId: joined.leaseId, clientId: "windows", capabilityToken: joined.capabilityToken, stateHash: joined.stateHash, idempotencyKey: "remember", entry: { scope: "scent", content: "e2e", tags: [], confidence: 1, source: "test" } }) });
  expect(await remembered.json()).toEqual({ id: "memory", createdAt: "now" });
  const recalled = await fetch(`${base}/v1/continuity/recall`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseId: joined.leaseId, clientId: "windows", capabilityToken: joined.capabilityToken, stateHash: joined.stateHash, query: "e2e", substrateScope: "episodic_memory" }) });
  expect(await recalled.json()).toEqual({ resolution: { ok: true, requestedScope: "episodic_memory", memoryScopes: ["episode", "observation"] }, results: [{ id: "memory", content: "e2e", scope: "episode", tags: [], confidence: 1, source: "test", createdAt: "now" }] });
  runtime.close();
});
