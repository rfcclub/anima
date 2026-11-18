import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TenantIdentityRuntime } from "../src/tenant-runtime.ts";
import { startTenantIdentityRuntimeHttp } from "../src/tenant-http.ts";
import { fakeContinuity } from "./fixtures/drain-host.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
function database() {
  const root = mkdtempSync(join(tmpdir(), "runtime-drain-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "runtime.db");
}
const input = { clientId: "test", surfaceId: "test", message: "synthetic" };
const entry = { scope: "observation" as const, content: "PRIVATE", source: "test", tags: [], confidence: 1 };

test("LD-01 drain admission and settlement", async () => {
  const pending = Promise.withResolvers<{ id: string; createdAt: string }>();
  const runtime = new TenantIdentityRuntime({ dbPath: database(), log: () => {}, tenants: new Map([["eli", { continuity: fakeContinuity(() => pending.promise) }]]) });
  cleanups.push(() => runtime.close());
  const server = startTenantIdentityRuntimeHttp(runtime, "127.0.0.1", 0);
  cleanups.push(() => { void server.stop(true); });
  const session = await runtime.join("eli", input);
  const write = runtime.remember({ ...session, clientId: "test", idempotencyKey: "one", entry });
  const drain = runtime.drain(1000);
  expect(runtime.drain(1000)).toBe(drain);
  expect((await fetch(server.url.origin + "/health")).status).toBe(503);
  await expect(runtime.join("eli", input)).rejects.toThrow("draining");
  expect((await fetch(server.url.origin + "/identity-runtime/eli/join", { method: "POST", body: JSON.stringify(input) })).status).toBe(503);
  pending.resolve({ id: "saved", createdAt: "now" });
  await write;
  expect(await drain).toEqual({ outcome: "drained", activeOperations: 0, pendingMutations: 0 });
});

test("LD-02 bounded unknown outcome survives restart without abandonment", async () => {
  const path = database();
  const pending = Promise.withResolvers<{ id: string; createdAt: string }>();
  const runtime = new TenantIdentityRuntime({ dbPath: path, log: () => {}, tenants: new Map([["eli", { continuity: fakeContinuity(() => pending.promise) }]]) });
  const session = await runtime.join("eli", input);
  const write = runtime.remember({ ...session, clientId: "test", idempotencyKey: "unknown", entry }).catch(() => {});
  expect(await runtime.drain(5)).toEqual({ outcome: "timed_out", activeOperations: 1, pendingMutations: 1 });
  // Settle the remote error only for test cleanup; an unknown outcome stays pending.
  pending.reject(new Error("transport lost"));
  await write;
  runtime.close();
  const restarted = new TenantIdentityRuntime({ dbPath: path, log: () => {}, tenants: new Map([["eli", { continuity: fakeContinuity() }]]) });
  cleanups.push(() => restarted.close());
  expect(restarted.pendingMutations("eli")).toHaveLength(1);
  await expect(restarted.join("eli", input)).rejects.toThrow("recovery required");
});

test("LD-03 deterministic restart preserves durable lease and completed mutation", async () => {
  const path = database();
  const tenants = new Map([["eli", { continuity: fakeContinuity() }]]);
  const first = new TenantIdentityRuntime({ dbPath: path, tenants, log: () => {} });
  const session = await first.join("eli", input);
  const req = { ...session, clientId: "test", idempotencyKey: "done", entry };
  const result = await first.remember(req);
  await first.drain(100);
  const second = new TenantIdentityRuntime({ dbPath: path, tenants, log: () => {} });
  expect(await second.directRecall({ ...session, clientId: "test", query: "probe" })).toEqual([]);
  expect(await second.remember(req)).toEqual(result);
  await second.drain(100);
  const expired = new TenantIdentityRuntime({ dbPath: path, tenants, now: () => session.expiresAt + 1, log: () => {} });
  cleanups.push(() => expired.close());
  await expect(expired.directRecall({ ...session, clientId: "test", query: "probe" })).rejects.toThrow("lease is unavailable");
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  for (const hang of [false, true]) {
    test(`LD-04 real process ${signal} ${hang ? "timeout" : "clean"}`, async () => {
      const path = database();
      const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/drain-host.ts", import.meta.url))], { env: { ...process.env, TEST_RUNTIME_DB: path, TEST_HANG: hang ? "1" : "0" }, stdout: "pipe", stderr: "pipe" });
      cleanups.push(() => { child.kill(); });
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let output = "";
      async function until(text: string) {
        while (!output.includes(text)) {
          const { value, done } = await reader.read();
          if (done) throw new Error("child exited before readiness");
          output += decoder.decode(value);
        }
      }
      await until("origin");
      const { origin } = JSON.parse(output.split("\n")[0]);
      const post = (route: string, body: unknown) => fetch(origin + route, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
      const session = await (await post("/identity-runtime/eli/join", input)).json();
      const request = post("/identity-runtime/continuity/remember", { ...session, clientId: "test", idempotencyKey: "signal", entry }).catch(() => undefined);
      await until("mutation-started");
      child.kill(signal);
      expect(await child.exited).toBe(hang ? 1 : 0);
      await request;
      while (true) { const { value, done } = await reader.read(); if (done) break; output += decoder.decode(value); }
      expect(output).toContain(hang ? '"outcome":"timed_out"' : '"outcome":"drained"');
      expect(output).not.toContain("PRIVATE");
      const db = new Database(path);
      expect(db.query("SELECT status FROM identity_runtime_mutations").get()).toEqual({ status: hang ? "pending" : "completed" });
      db.close();
    }, 5000);
  }
}

test("LD-04 actual standalone main installs the signal coordinator", async () => {
  const path = database();
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
    env: { ...process.env, IDENTITY_RUNTIME_DB: path, IDENTITY_RUNTIME_MESH_DB: path + ".mesh", IDENTITY_RUNTIME_ENV_FILE: path + ".absent", IDENTITY_RUNTIME_HOST: "127.0.0.1", IDENTITY_RUNTIME_PORT: "0", ANIMA_CONTINUITY_URL: "http://127.0.0.1:1", TYPESAFE_API_KEY: "" },
    stdout: "pipe", stderr: "pipe",
  });
  cleanups.push(() => { child.kill(); });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("identity-runtime listening")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("standalone main failed to start");
    output += decoder.decode(value);
  }
  child.kill("SIGTERM");
  expect(await child.exited).toBe(0);
  while (true) { const { value, done } = await reader.read(); if (done) break; output += decoder.decode(value); }
  expect(output).toContain('"outcome":"drained"');
  expect(output).toContain('"pendingMutations":0');
}, 5000);
