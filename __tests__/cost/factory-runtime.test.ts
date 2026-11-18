import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Separate processes prevent unrelated proxy/module mocks from substituting a
// factory under test. No HOME override, live database, account, API or listener.
const sites = [
  "proxy-explicit", "proxy-scan", "proxy-override-registry", "proxy-override-inline",
  "reflection", "shared-speech", "expedition", "talk-router", "meeting-chat", "meeting-responses",
  "cli-chat", "cli-responses", "cli-router",
  "channel-chat", "channel-responses", "channel-router", "server",
  "castle-direct", "castle-router", "castle-summary", "castle-summarizer", "castle-session", "castle-stream",
  "server-claude", "server-gemini", "meeting-claude", "meeting-gemini",
  "channel-claude", "cli-claude", "castle-claude", "castle-gemini",
];

async function runFactoryFixture(site: string) {
    const root = mkdtempSync(join(tmpdir(), "anima-factory-"));
    for (const dir of ["state", "ui", "rooms"]) mkdirSync(join(root, dir), { recursive: true });
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/factory-runtime.ts"), site], {
      cwd: root,
      env: {
        ...Object.fromEntries(["PATH", "TMPDIR"].flatMap((key) =>
          process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
        TZ: "UTC", NODE_ENV: "test", ANIMA_FACTORY_TEST_ROOT: root,
        ANIMA_HOME: root, ANIMA_ROOMS_DIR: join(root, "rooms"),
        ANIMA_STATE_DIR: join(root, "state"), ANIMA_UI_STATE_DIR: join(root, "ui"),
        ANIMA_SESSIONS_DB: join(root, "sessions.db"), ANIMA_COST_DB: ":memory:",
        ANIMA_SHARED_CONVERSATIONS: "0", ANIMA_ACTIVATION_MODE: "off",
        ANIMA_BREAKER_DISABLED: "false", ANIMA_BREAKER_FILE: join(root, "breaker.json"),
        ANIMA_PROXY_OVERRIDES: join(root, "overrides.yaml"),
        GEMINI_API_KEY: "fixture-key",
        ANIMA_CORE_HOST: "127.0.0.1", ANIMA_CORE_ALLOWED_ORIGINS: "", PORT: "3700",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 15_000);
    try {
      const [exit, stdout, stderr] = await Promise.all([
        proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
      ]);
      expect({ exit, stderr: exit === 0 ? "" : stderr, stdout: exit === 0 ? "" : stdout }).toEqual({ exit: 0, stderr: "", stdout: "" });
      const lastLine = stdout.trim().split("\n").at(-1);
      if (!lastLine) throw new Error(`${site}: missing receipt; stderr=${stderr}`);
      const receipt = JSON.parse(lastLine);
      expect(receipt).toMatchObject({ site, leafCalls: 1, parents: 1 });
    } finally {
      clearTimeout(timer);
      rmSync(root, { recursive: true, force: true });
    }
}

for (const site of sites) {
  test(`CL-10 runtime: ${site} queries its factory once with agent and session or path`, () => runFactoryFixture(site), 20_000);
}

test("CL-10 regression: unauthorized parent environment does not reach the real factory child", async () => {
  const keys = ["ANIMA_FACTORY_FORBIDDEN_CANARY", "ANTHROPIC_API_KEY", "GH_TOKEN"];
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "fixture-parent-canary";
    await runFactoryFixture("proxy-explicit");
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}, 20_000);

