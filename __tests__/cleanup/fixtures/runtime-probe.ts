import { mock, spyOn } from "bun:test";
import * as os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { strict as assert } from "node:assert";

const dir = mkdtempSync(join(os.tmpdir(), "anima-dead-runtime-"));
const originalHome = os.homedir();
const fakeOs = { ...os, homedir: () => dir };
mock.module("node:os", () => ({ ...fakeOs, default: fakeOs }));
// Bun's ESM mock does not replace built-ins loaded with require().
require("node:os").homedir = fakeOs.homedir;
assert.equal((await import("node:os")).homedir(), dir, "temp-only home mock must apply before imports");
assert.equal(require("node:os").homedir(), dir, "context-store's require must also use the fixture home");
Object.assign(process.env, {
  ANIMA_SHARED_CONVERSATIONS: "0", ANIMA_ACTIVATION_MODE: "off", ANIMA_COST_DB: ":memory:",
  ANIMA_STATE_DIR: join(dir, "state"), ANIMA_UI_STATE_DIR: join(dir, "ui-state"),
  ANIMA_ROOMS_DIR: join(dir, "rooms"), ANIMA_UI_HOST: "127.0.0.1",
});
mkdirSync(join(dir, "state"), { recursive: true });
mkdirSync(join(dir, "rooms", "_shared"), { recursive: true });

try {
  if (process.argv[2] === "health") {
    const { AgentLoader } = await import("../../../src/agents/loader");
    const { MemoryHealthRegistry } = await import("../../../src/memory/health-registry");
    MemoryHealthRegistry.reset();
    const registry = MemoryHealthRegistry.getInstance();
    const spy = spyOn(registry, "register");
    const room = join(dir, "rooms", "fixture");
    mkdirSync(room, { recursive: true });
    writeFileSync(join(room, "gene.md"), "Fixture instructions only.");
    writeFileSync(join(room, "config.yaml"), JSON.stringify({
      identity: { name: "fixture", label: "Fixture" }, provider: { type: "claude" },
      policy: { allowedRoots: [room], allowedTools: [] }, session: { defaultMode: "plan" },
      boot: { gene: "gene.md", sessionContext: ["gene.md"] }, memory: { type: "shared" },
    }));
    const loader = new AgentLoader({ roomsDir: join(dir, "rooms"), agentSourceDir: join(dir, "sources"), substrateDir: join(dir, "substrate"), log() {} });
    const loaded = await loader.load("fixture");
    assert.ok(loaded.memoryStore);
    assert.equal(registry.get("fixture"), loaded.memoryStore);
    const registrations = spy.mock.calls.length;
    const stores = registry.getAll().length;
    loaded.contextEngine?.dispose();
    (loaded.memoryAdapter as any).close();
    (loaded.memoryStore as any).close();
    spy.mockRestore();
    assert.equal(registrations, 1, "real loader + factory must register once");
    console.log(JSON.stringify({ registrations, stores, tempOnly: originalHome !== dir && fakeOs.homedir() === dir }));
  } else {
    const { handleRequest } = await import("../../../src/server");
    const { startUIServer } = await import("../../../src/ui/app/server");
    delete process.env.ANIMA_UI_PORT;
    const original = new URL("http://127.0.0.1:3700/cost?since=2026-01-01");
    const request = () => new Request(original, { headers: { host: original.host } });
    delete process.env.ANIMA_UI_ENABLED;
    const disabled = await handleRequest(request());
    process.env.ANIMA_UI_ENABLED = "true";
    process.env.ANIMA_CORE_ALLOWED_ORIGINS = "https://console.example.test";
    const proxy = await handleRequest(new Request("https://console.example.test/cost", { headers: { host: "console.example.test" } }));
    delete process.env.ANIMA_CORE_ALLOWED_ORIGINS;
    console.log(JSON.stringify({ disabledStatus: disabled.status, disabledLocation: disabled.headers.get("location"), proxyStatus: proxy.status, proxyLocation: proxy.headers.get("location") }));
    assert.equal(disabled.status, 503, "UI-disabled core must explicitly refuse instead of redirecting to a dead port");
    assert.equal(disabled.headers.get("location"), null);
    assert.equal((await disabled.json()).error, "cost_ui_unavailable");
    assert.equal(proxy.status, 503, "public/proxy authority must not be rewritten to an internal UI port");
    assert.equal(proxy.headers.get("location"), null);
    for (const value of ["NaN", "0", "-1", "65536", "3000.5", ""]) {
      process.env.ANIMA_UI_PORT = value;
      const invalid = await handleRequest(request());
      assert.equal(invalid.status, 503, `invalid UI port ${JSON.stringify(value)} must not redirect`);
      assert.equal(invalid.headers.get("location"), null);
    }
    delete process.env.ANIMA_UI_PORT;
    const defaultResponse = await handleRequest(request());
    assert.equal(defaultResponse.status, 302);
    assert.equal(defaultResponse.headers.get("location"), "http://127.0.0.1:3000/cost?since=2026-01-01");
    // Redirect construction must preserve both hostname forms and escaped query values.
    for (const origin of ["http://localhost:3700", "http://[::1]:3700"]) {
      const url = new URL("/cost?agentId=a%26b&until=2026-02-03", origin);
      const response = await handleRequest(new Request(url, { headers: { host: url.host } }));
      url.port = "3000";
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), url.toString());
    }
    process.env.ANIMA_UI_PORT = "0";
    const server = startUIServer({ roomsDir: join(dir, "rooms") });
    const port = server.port!;
    try {
      process.env.ANIMA_UI_PORT = String(port);
      const configured = await handleRequest(request());
      assert.equal(configured.status, 302);
      assert.equal(configured.headers.get("location"), `http://127.0.0.1:${port}/cost?since=2026-01-01`);
      const ui = await fetch(configured.headers.get("location")!);
      assert.equal(ui.status, 200);
      assert.match(await ui.text(), /<!doctype html/i);
      server.stop(true);
      let listenerClosed = false;
      try { await fetch(`http://127.0.0.1:${port}/cost`); } catch { listenerClosed = true; }
      assert.equal(listenerClosed, true);
      console.log(JSON.stringify({ defaultStatus: defaultResponse.status, configuredStatus: configured.status, disabledStatus: disabled.status, proxyStatus: proxy.status, uiStatus: ui.status, listenerClosed }));
    } finally { server.stop(true); }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
