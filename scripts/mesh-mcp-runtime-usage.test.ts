import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_MESH_TOOLS,
  ensureReadOnlyMode,
  listToolsViaMcp,
  mcpExchange,
  parseSnippet,
  runMcpRoundTrip,
  runMcpRoundTripDetails,
  validateRuntimeConfigs,
  type RuntimeMcpConfig,
} from "./mesh-mcp-runtime-usage";

function localMcpConfig(home: string, notifyUrl: string): RuntimeMcpConfig {
  // Blanking inherited keys prevents credentials and native carrier capabilities
  // from reaching this local-only protocol fixture through mcpExchange's merge.
  const env = Object.fromEntries(Object.keys(process.env).map((key) => [key, ""]));
  return {
    runtime: "codex",
    command: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.resolve("colony-mesh/package.json"))), "bin/colony-mesh.ts")],
    env: {
      ...env,
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      HOME: home,
      MESH_INSTANCE_ID: "fixture-sender",
      MESH_PLATFORM: "codex",
      ANIMA_NOTIFY_URL: notifyUrl,
    },
  };
}

async function withLocalMcp(run: (config: RuntimeMcpConfig) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "mesh-mcp-home-"));
  const notifications = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("fixture notification accepted"),
  });
  try {
    await run(localMcpConfig(home, notifications.url.href));
  } finally {
    notifications.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}

describe("MCP runtime config validation", () => {
  test("rejects duplicate mesh identities", () => {
    expect(validateRuntimeConfigs([
      { runtime: "claude", command: "colony-mesh", args: [], env: { MESH_INSTANCE_ID: "bruno", MESH_PLATFORM: "cc" } },
      { runtime: "qwen", command: "colony-mesh", args: [], env: { MESH_INSTANCE_ID: "bruno", MESH_PLATFORM: "cc" } },
    ])).toContain("qwen and claude share mesh identity bruno/cc");
  });

  test("allows shared bare ids on different platforms", () => {
    expect(validateRuntimeConfigs([
      { runtime: "claude", command: "colony-mesh", args: [], env: { MESH_INSTANCE_ID: "bruno", MESH_PLATFORM: "cc" } },
      { runtime: "qwen", command: "colony-mesh", args: [], env: { MESH_INSTANCE_ID: "bruno", MESH_PLATFORM: "qwen" } },
    ])).toEqual([]);
  });

  test("rejects missing command", () => {
    expect(validateRuntimeConfigs([
      { runtime: "gemini", command: "", args: [], env: { MESH_INSTANCE_ID: "bruno", MESH_PLATFORM: "gemini" } },
    ])).toContain("gemini: missing command");
  });

  test("rejects prefixed runtime ids", () => {
    expect(validateRuntimeConfigs([
      { runtime: "claude", command: "colony-mesh", args: [], env: { MESH_INSTANCE_ID: "cli-bruno", MESH_PLATFORM: "cc" } },
    ])).toContain("claude: MESH_INSTANCE_ID must be a bare id, got cli-bruno");
  });

  test("rejects missing platform", () => {
    expect(validateRuntimeConfigs([
      { runtime: "claude", command: "colony-mesh", args: [], env: { MESH_INSTANCE_ID: "bruno" } },
    ])).toContain("claude: missing MESH_PLATFORM");
  });

  test("default validator mode is read-only", () => {
    expect(() => ensureReadOnlyMode(false)).not.toThrow();
    expect(() => ensureReadOnlyMode(true)).toThrow("--apply is not implemented");
  });

  test("parses config snippets", () => {
    const config = parseSnippet("docs/mcp-runtime-configs/codex.toml", "codex");
    expect(config.command).toBe("colony-mesh");
    expect(config.env.MESH_INSTANCE_ID).toBe("agent-a");
    expect(config.env.MESH_PLATFORM).toBe("codex");
  });
});

describe("MCP stdio behavior", () => {
  test("regression: fixture uses the installed package and excludes parent capabilities", async () => {
    const canary = "ANIMA_FIXTURE_PARENT_SECRET";
    const old = process.env[canary];
    process.env[canary] = "must-not-reach-child";
    try {
      await withLocalMcp(async (config) => {
        expect(config.command).toBe(process.execPath);
        expect(config.args[0]).toBe(join(dirname(fileURLToPath(import.meta.resolve("colony-mesh/package.json"))), "bin/colony-mesh.ts"));
        expect(config.env[canary]).toBe("");
        for (const key of Object.keys(process.env)) {
          if (!["PATH", "TMPDIR", "HOME", "MESH_INSTANCE_ID", "MESH_PLATFORM", "ANIMA_NOTIFY_URL"].includes(key)) {
            expect(config.env[key]).toBe("");
          }
        }
        expect(config.env.MESH_INSTANCE_ID).toBe("fixture-sender");
        expect(config.env.ANIMA_NOTIFY_URL).toStartWith("http://127.0.0.1:");
        const replies = await mcpExchange({
          ...config,
          args: [join(import.meta.dir, "fixtures/mcp-env-fixture.ts")],
          requests: [{ jsonrpc: "2.0", id: 1, method: "fixture/env" }],
        });
        expect(replies[0]?.result).toEqual({
          parentSecretPresent: false,
          nativeCarrierPresent: false,
          telegramPresent: false,
          home: config.env.HOME,
          sender: "fixture-sender",
        });
      });
    } finally {
      if (old === undefined) delete process.env[canary];
      else process.env[canary] = old;
    }
  });

  test("tools/list exposes exactly the mesh surface", async () => {
    await withLocalMcp(async (config) => {
      const tools = await listToolsViaMcp(config);
      expect(tools).toEqual([...EXPECTED_MESH_TOOLS]);
    });
  });

  test("register/send/pull/ack round trip succeeds through MCP", async () => {
    await withLocalMcp(async (config) => {
      await expect(runMcpRoundTrip(config)).resolves.toBe(true);
    });
  });

  test("mesh_pull output exposes platform metadata", async () => {
    await withLocalMcp(async (config) => {
      const result = await runMcpRoundTripDetails(config, "fixture-recipient", "anima");
      expect(result.ok).toBe(true);
      expect(result.pullText).toContain("fixture-sender [codex]");
      expect(result.pullText).toContain("fixture-recipient [anima]");
    });
  });
});
