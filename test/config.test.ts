import { expect, test } from "bun:test";
import { ConfigValidationError, loadRoomConfig } from "../src/config/types";

const validConfig = `
identity:
  name: cleo
  label: Bodega Owner
provider:
  type: claude
  model: claude-3-5-sonnet-20241022
policy:
  allowedRoots: ["/home/user/work/anima/rooms/cleo/staging"]
  readOnlyRoots: ["/home/user/work/anima/rooms/cleo/mount"]
session:
  defaultMode: edit
  idleTimeoutMs: 300000
  maxTokens: 4096
boot:
  gene: SOUL.md
  soul: SOUL.md
  sessionContext:
    - AGENTS.md
  additional: ["banter.md"]
`;

test("loadRoomConfig should parse valid YAML", () => {
  const config = loadRoomConfig(validConfig);
  expect(config.identity.name).toBe("cleo");
  expect(config.provider.type).toBe("claude");
  expect(config.policy.allowedRoots).toContain("/home/user/work/anima/rooms/cleo/staging");
  expect(config.session.defaultMode).toBe("edit");
  expect(config.session.autoModeOptIn).toBe(false);
  expect(config.session.compactThreshold).toBe(60000);
  expect(config.boot.gene).toBe("SOUL.md");
  expect(config.boot.sessionContext).toEqual([{ path: "AGENTS.md" }]);
  expect(config.boot.additional).toContain("banter.md");
});

test("loadRoomConfig should parse custom compact threshold", () => {
  const config = loadRoomConfig(validConfig.replace("maxTokens: 4096", "maxTokens: 4096\n  compactThreshold: 30000"));

  expect(config.session.compactThreshold).toBe(30000);
});

test("loadRoomConfig should parse MCP servers", () => {
  const config = loadRoomConfig(`${validConfig}
mcp:
  servers:
    - name: filesystem
      command: bun
      args: ["mock-mcp.ts", "/tmp/work"]
      env:
        MCP_MODE: test
`);

  expect(config.mcp?.servers).toEqual([
    {
      name: "filesystem",
      command: "bun",
      args: ["mock-mcp.ts", "/tmp/work"],
      env: { MCP_MODE: "test" },
    },
  ]);
});

test("loadRoomConfig should throw ConfigValidationError for missing required fields", () => {
  const yamlText = `
identity:
  name: cleo
  label: Bodega Owner
provider:
  type: claude
  model: claude-3-5-sonnet-20241022
policy:
  allowedRoots: ["/home/user/work/anima/rooms/cleo/staging"]
  readOnlyRoots: ["/home/user/work/anima/rooms/cleo/mount"]
session:
  defaultMode: edit
  idleTimeoutMs: 300000
  maxTokens: 4096
boot:
  additional: ["banter.md"]
`;

  expect(() => loadRoomConfig(yamlText)).toThrow(ConfigValidationError);
  expect(() => loadRoomConfig(yamlText)).toThrow("boot.gene");
});

test("loadRoomConfig should require allowedTools when auto mode is enabled", () => {
  const yamlText = validConfig.replace("defaultMode: edit", "defaultMode: auto\n  autoModeOptIn: true");

  expect(() => loadRoomConfig(yamlText)).toThrow(ConfigValidationError);
  expect(() => loadRoomConfig(yamlText)).toThrow("allowedTools required when autoModeOptIn is true");
});

// ── ContextManagementConfig ──────────────────────────────────────────────

test("contextManagement defaults to undefined when absent", () => {
  const config = loadRoomConfig(validConfig);
  expect(config.contextManagement).toBeUndefined();
});

test("contextManagement parses branching mode with defaults", () => {
  const config = loadRoomConfig(`${validConfig}
contextManagement:
  mode: branching
`);
  expect(config.contextManagement).toBeDefined();
  expect(config.contextManagement!.mode).toBe("branching");
  expect(config.contextManagement!.tokenBudget).toBe(40_000);
  expect(config.contextManagement!.protectedWindow).toBe(10);
  expect(config.contextManagement!.summarizeThreshold).toBe(1500);
  expect(config.contextManagement!.stubThreshold).toBe(300);
  expect(config.contextManagement!.ftsHotK).toBe(5);
});

test("contextManagement parses flat mode explicitly", () => {
  const config = loadRoomConfig(`${validConfig}
contextManagement:
  mode: flat
`);
  expect(config.contextManagement).toBeDefined();
  expect(config.contextManagement!.mode).toBe("flat");
});

test("contextManagement parses custom overrides", () => {
  const config = loadRoomConfig(`${validConfig}
contextManagement:
  mode: branching
  tokenBudget: 80000
  protectedWindow: 20
  summarizeThreshold: 2000
  stubThreshold: 500
  ftsHotK: 10
`);
  expect(config.contextManagement!.mode).toBe("branching");
  expect(config.contextManagement!.tokenBudget).toBe(80_000);
  expect(config.contextManagement!.protectedWindow).toBe(20);
  expect(config.contextManagement!.summarizeThreshold).toBe(2000);
  expect(config.contextManagement!.stubThreshold).toBe(500);
  expect(config.contextManagement!.ftsHotK).toBe(10);
});

test("contextManagement rejects invalid mode", () => {
  const yamlText = `${validConfig}
contextManagement:
  mode: invalid
`;
  expect(() => loadRoomConfig(yamlText)).toThrow(ConfigValidationError);
});
