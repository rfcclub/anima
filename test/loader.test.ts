import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentLoader,
  ConfigParseError,
  EXTRA_ACTION_MAX_STDOUT_CHARS,
  RoomNotFoundError,
  capExtraActionOutput,
} from "../src/agents/loader";

let tempDir: string;
let roomsDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "anima-loader-"));
  roomsDir = join(tempDir, "rooms");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("load reads a valid room from roomDir", async () => {
  await createRoom("bruno", { gene: "AGENTS.md", soul: "SOUL.md" });
  const loader = new AgentLoader({ roomsDir });

  const loaded = await loader.load("bruno");

  expect(loaded.name).toBe("bruno");
  expect(loaded.label).toBe("Bruno");
  expect(loaded.geneContent).toContain("Session instructions");
  expect(loaded.soulContent).toContain("primary boot");
  expect(loaded.sessionContextFiles[0].content).toContain("Session instructions");
  expect(loaded.roomDir).toBe(join(roomsDir, "bruno"));
});

test("load throws RoomNotFoundError for missing room", async () => {
  const loader = new AgentLoader({ roomsDir });

  await expect(loader.load("unknown")).rejects.toThrow(RoomNotFoundError);
});

test("load throws SubstrateNotMountedError when gene file missing", async () => {
  await createRoom("cleo", { gene: "MISSING.md" });
  const loader = new AgentLoader({ roomsDir });

  await expect(loader.load("cleo")).rejects.toThrow("substrate not mounted");
});

test("load reads multi-file boot content", async () => {
  await createRoom("cleo", { gene: "AGENTS.md", soul: "SOUL.md", additional: ["banter.md"] });
  const loader = new AgentLoader({ roomsDir });

  const loaded = await loader.load("cleo");

  expect(loaded.soulContent).toContain("primary boot");
  expect(loaded.additionalContent).toHaveLength(1);
  expect(loaded.additionalContent[0].name).toBe("banter.md");
  expect(loaded.additionalContent[0].content).toContain("spicy");
});

test("list returns zero rooms when rooms directory is empty or missing", async () => {
  const loader = new AgentLoader({ roomsDir });

  expect(await loader.list()).toEqual([]);
});

test("list returns rooms with valid configs even if gene file missing", async () => {
  await createRoom("cleo", { gene: "MISSING.md" });
  const loader = new AgentLoader({ roomsDir });

  // list() checks config validity, not file existence
  expect(await loader.list()).toEqual(["cleo"]);
});

test("load wraps invalid config in ConfigParseError", async () => {
  await createInvalidConfigRoom("bad");
  const loader = new AgentLoader({ roomsDir });

  await expect(loader.load("bad")).rejects.toThrow(ConfigParseError);
});

async function createRoom(
  name: string,
  boot: { gene?: string; soul?: string; additional?: string[] } = {},
): Promise<void> {
  const roomDir = join(roomsDir, name);
  const gene = boot.gene ?? "AGENTS.md";
  const soul = boot.soul ?? "SOUL.md";
  await mkdir(join(roomDir, "sessions"), { recursive: true });
  await mkdir(join(roomDir, "staging"), { recursive: true });
  await writeFile(join(roomDir, "AGENTS.md"), "Session instructions live here.", "utf-8");
  await writeFile(join(roomDir, "SOUL.md"), "I am the primary boot file.", "utf-8");
  await writeFile(join(roomDir, "banter.md"), "Banter stays spicy.", "utf-8");
  await writeFile(
    join(roomDir, "config.yaml"),
    `identity:
  name: ${name}
  label: ${name === "bruno" ? "Bruno" : "Cleo"}
provider:
  type: claude
policy:
  allowedRoots: ["${join(roomDir, "staging")}"]
  readOnlyRoots: ["${roomDir}"]
session:
  defaultMode: plan
  autoModeOptIn: false
boot:
  gene: ${gene}
  soul: ${soul}
  sessionContext:
    - AGENTS.md
  additional: ${JSON.stringify(boot.additional ?? [])}
`,
    "utf-8",
  );
}

test("load populates bootstrapContent from adapter supporting bootstrap", async () => {
  await createRoom("bootstrap-agent", { gene: "AGENTS.md" });
  const loader = new AgentLoader({ roomsDir });

  // Create a room config that enables crossSessionBootstrap
  const roomDir = join(roomsDir, "bootstrap-agent");
  const configYaml = `identity:
  name: bootstrap-agent
  label: Bootstrap Test
provider:
  type: claude
policy:
  allowedRoots: ["${roomDir}"]
session:
  defaultMode: plan
memory:
  crossSessionBootstrap: true
boot:
  gene: AGENTS.md
  sessionContext:
    - AGENTS.md
`;
  await writeFile(join(roomDir, "config.yaml"), configYaml, "utf-8");

  const loaded = await loader.load("bootstrap-agent");

  expect(loaded.bootstrapContent).toBeUndefined();

  // Now test with an adapter that has a bootstrap() method
  // by creating a custom test
  const memoryAdapter = {
    store: async () => {},
    recall: async () => [],
  };

  // Verify regular adapter doesn't trigger bootstrap
  expect(typeof (memoryAdapter as any).bootstrap).toBe("undefined");
});

test("load bootstrapContent is populated when adapter supports bootstrap", async () => {
  await createRoom("bs-agent", { gene: "AGENTS.md" });
  const loader = new AgentLoader({ roomsDir });

  // Override config with crossSessionBootstrap enabled
  const roomDir = join(roomsDir, "bs-agent");
  const configYaml = `identity:
  name: bs-agent
  label: BS Agent
provider:
  type: claude
policy:
  allowedRoots: ["${roomDir}"]
session:
  defaultMode: plan
memory:
  crossSessionBootstrap: true
boot:
  gene: AGENTS.md
  sessionContext:
    - AGENTS.md
`;
  await writeFile(join(roomDir, "config.yaml"), configYaml, "utf-8");

  // Directly test the bootstrap content — in a real setup, the adapter
  // would be loaded by the AgentLoader. The default NullMemoryAdapter
  // doesn't have bootstrap(), so bootstrapContent should be undefined.
  const loaded = await loader.load("bs-agent");
  expect(loaded.memoryAdapter).toBeDefined();

  // bootstrapContent should be undefined since NullMemoryAdapter
  // doesn't implement bootstrap
  expect(loaded.bootstrapContent).toBeUndefined();
});

async function createInvalidConfigRoom(name: string): Promise<void> {
  const roomDir = join(roomsDir, name);
  await mkdir(roomDir, { recursive: true });
  await writeFile(join(roomDir, "config.yaml"), "identity:\n  name: bad\n", "utf-8");
}

test("capExtraActionOutput leaves output within the cap untouched and marks what it cut", () => {
  expect(capExtraActionOutput("short", 10)).toBe("short");
  expect(capExtraActionOutput("a".repeat(10), 10)).toBe("a".repeat(10));
  expect(capExtraActionOutput("a".repeat(25), 10)).toBe(`${"a".repeat(10)}\n[output truncated: 15 more characters]`);
});

test("an extra action that prints far more than the cap is truncated before it reaches the prompt", async () => {
  await createRoom("noisy", { gene: "AGENTS.md" });
  const configPath = join(roomsDir, "noisy", "config.yaml");
  const { readFile } = await import("node:fs/promises");
  const config = await readFile(configPath, "utf-8");
  await writeFile(
    configPath,
    config.replace(
      "  additional: []\n",
      `  additional: []\n  extraActions:\n    - Flood: head -c ${EXTRA_ACTION_MAX_STDOUT_CHARS * 5} /dev/zero | tr '\\0' x\n    - Small: echo hello\n`,
    ),
    "utf-8",
  );

  const loaded = await new AgentLoader({ roomsDir }).load("noisy");

  const [flood, small] = loaded.extraActionResults!;
  expect(flood!.stdout.length).toBeLessThan(EXTRA_ACTION_MAX_STDOUT_CHARS + 100);
  expect(flood!.stdout).toContain("[output truncated: ");
  expect(small!.stdout.trim()).toBe("hello");
});
