import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TenantIdentityRuntime } from "../../packages/identity-runtime/src/tenant-runtime.ts";
import { startTenantIdentityRuntimeHttp } from "../../packages/identity-runtime/src/tenant-http.ts";
import { verifyHost } from "./verify-host.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function host() {
  const root = mkdtempSync(join(tmpdir(), "host-verifier-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const memories: string[] = [];
  let revision = 0;
  const runtime = new TenantIdentityRuntime({ dbPath: join(root, "runtime.db"), log: () => {}, tenants: new Map([["eli", { continuity: {
    compile: async (input) => ({
      projection: { prompt: "PRIVATE PROJECTION", promptStaticHash: "static", kernelVersion: "kernel", substrateViewVersion: "view", cartridgeVersions: {}, readScopes: ["observation"], writeScopes: ["observation"], proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "none" },
      grant: { grantId: "grant", identity: "eli", surfaceId: input.surfaceId, projectionId: "projection", stateHash: String(revision), writeScopes: ["observation"], issuedAt: Date.now(), expiresAt: Date.now() + 60000 },
    }),
    remember: async ({ entry }) => { memories.push(entry.content); revision++; return { id: "probe", createdAt: new Date().toISOString() }; },
    recall: async () => { throw new Error("unused"); },
    directRecall: async ({ stateHash }) => {
      if (stateHash !== String(revision)) throw new Error("stale");
      return [{ source: "test", content: "PRIVATE MEMORY" }, ...memories.map(content => ({ source: "test", content }))];
    },
  } }]]) });
  cleanup.push(() => runtime.close());
  const server = startTenantIdentityRuntimeHttp(runtime, "127.0.0.1", 0);
  cleanup.push(() => { void server.stop(true); });
  return { origin: server.url.origin, memories };
}

test("HV-01 valid host roundtrip and HV-02 session auth boundaries", async () => {
  const h = host();
  const result = await verifyHost({ origin: h.origin, tenant: "eli", writeProbe: true, pollAttempts: 2, pollIntervalMs: 1 });
  expect(result.ok).toBe(true);
  expect(result.complete).toBe(true);
  expect(result.checks.filter(c => c.name.startsWith("auth-")).map(c => c.status)).toEqual(["pass", "pass", "pass", "pass"]);
  expect(h.memories).toHaveLength(1);
  const output = JSON.stringify(result);
  expect(output).not.toContain("PRIVATE");
  expect(output).not.toContain(h.memories[0]);
});

test("HV-04 explicit write: read-only does not mutate or claim complete", async () => {
  const h = host();
  const result = await verifyHost({ origin: h.origin, tenant: "eli" });
  expect(result.ok).toBe(true);
  expect(result.complete).toBe(false);
  expect(h.memories).toHaveLength(0);
  expect(result.checks.at(-1)?.status).toBe("skip");
});

test("HV-03 safe bounded failure does not expose response or exception text", async () => {
  for (const fetcher of [
    async () => Response.json({ error: "SECRET TOKEN PRIVATE MEMORY" }, { status: 500 }),
    async () => Response.json({ projection: "PRIVATE" }),
    async () => { throw new Error("SECRET TOKEN"); },
  ]) {
    const result = await verifyHost({ origin: "http://localhost", tenant: "eli", fetcher });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE/);
  }
});

test("HV-03 permissive auth is detected before remember", async () => {
  let writes = 0;
  const result = await verifyHost({ origin: "http://localhost", tenant: "eli", writeProbe: true, fetcher: async (url) => {
    if (String(url).endsWith("/join")) return Response.json({ projection: "private", leaseId: "lease", sessionToken: "SECRET", stateHash: "state", expiresAt: Date.now() + 60000, writeScopes: ["observation"] });
    if (String(url).endsWith("/remember")) writes++;
    return Response.json([]);
  } });
  expect(result.ok).toBe(false);
  expect(writes).toBe(0);
});

test("HV-04 CLI fails safely and configuration is validated before requests", async () => {
  let requests = 0;
  for (const origin of ["file:///tmp/a", "http://user:SECRET@localhost", "http://localhost/?secret=x"]) {
    const result = await verifyHost({ origin, tenant: "eli", fetcher: async () => { requests++; return Response.json({}); } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  }
  expect(requests).toBe(0);
  const proc = Bun.spawn([process.execPath, "scripts/identity-runtime/verify-host.ts", "--unknown"], { stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stdout).text()).toContain("configuration");
});

test("HV-03 missing probe fails after bounded polling with one write only", async () => {
  const h = host();
  let recalledAfterWrite = 0;
  const result = await verifyHost({ origin: h.origin, tenant: "eli", writeProbe: true, pollAttempts: 2, pollIntervalMs: 1, fetcher: async (url, init) => {
    const response = await fetch(url, init);
    if (h.memories.length && url.endsWith("/direct-recall")) {
      recalledAfterWrite++;
      await response.body?.cancel();
      return Response.json([{ source: "test", content: "unrelated private memory" }]);
    }
    return response;
  } });
  expect(result.ok).toBe(false);
  expect(result.checks.at(-1)?.code).toBe("probe-not-recalled");
  expect(recalledAfterWrite).toBe(2);
  expect(h.memories).toHaveLength(1);
});

test("HV-03 network deadline and HV-04 portable CLI succeed with redacted output", async () => {
  const slow = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => { await Bun.sleep(100); return Response.json({}); } });
  cleanup.push(() => { void slow.stop(true); });
  const start = performance.now();
  expect((await verifyHost({ origin: slow.url.origin, tenant: "eli", timeoutMs: 10 })).ok).toBe(false);
  expect(performance.now() - start).toBeLessThan(500);
  const h = host();
  const child = Bun.spawn([process.execPath, "scripts/identity-runtime/verify-host.ts", "--write-probe"], { env: { ...process.env, IDENTITY_RUNTIME_URL: h.origin, IDENTITY_RUNTIME_TENANT: "eli" }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  const stdout = await new Response(child.stdout).text();
  expect(JSON.parse(stdout).complete).toBe(true);
  expect(stdout).not.toContain("PRIVATE");
  expect(stdout).not.toContain(h.memories[0]);
});
