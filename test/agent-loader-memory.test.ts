import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentLoader } from "../src/agents/loader";
import { NullMemoryAdapter } from "../src/memory/null-adapter";
import type { MemoryAdapter } from "../src/memory/adapter";

let tempDir: string;
let roomsDir: string;
let logEntries: { level: string; msg: string; fields?: Record<string, unknown> }[];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "anima-loader-mem-"));
  roomsDir = join(tempDir, "rooms");
  logEntries = [];
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeLog() {
  return (level: "info" | "warn", msg: string, fields?: Record<string, unknown>) => {
    logEntries.push({ level, msg, fields });
  };
}

test("agent with no adapter file returns NullMemoryAdapter", async () => {
  await createRoom("no-mem");
  const loader = new AgentLoader({ roomsDir, log: makeLog() });

  const loaded = await loader.load("no-mem");

  expect(loaded.memoryAdapter).toBeInstanceOf(NullMemoryAdapter);
  expect(logEntries).toContainEqual({
    level: "info",
    msg: "no memory adapter found, using null",
    fields: { agent: "no-mem", module: "memory-adapter.js" },
  });
});

test("agent with valid adapter returns loaded implementation", async () => {
  await createRoom("has-mem");
  const adapterCode = `
export default {
  async store(entry) { this._entries.push(entry); },
  async recall(query, opts) { return this._entries.slice(0, opts?.topK ?? 10); },
  _entries: [],
};
`;
  await writeFile(join(roomsDir, "has-mem", "memory-adapter.js"), adapterCode, "utf-8");

  const loader = new AgentLoader({ roomsDir, log: makeLog() });

  const loaded = await loader.load("has-mem");

  expect(loaded.memoryAdapter).not.toBeInstanceOf(NullMemoryAdapter);
  expect(typeof loaded.memoryAdapter.store).toBe("function");
  expect(typeof loaded.memoryAdapter.recall).toBe("function");
  expect(logEntries).toContainEqual({
    level: "info",
    msg: "memory adapter loaded",
    fields: { agent: "has-mem", module: "memory-adapter.js" },
  });
});

test("agent with invalid export (exports null) falls back to NullMemoryAdapter + warning logged", async () => {
  await createRoom("bad-mem");
  await writeFile(join(roomsDir, "bad-mem", "memory-adapter.js"), "export default null;", "utf-8");

  const loader = new AgentLoader({ roomsDir, log: makeLog() });

  const loaded = await loader.load("bad-mem");

  expect(loaded.memoryAdapter).toBeInstanceOf(NullMemoryAdapter);
  expect(logEntries).toContainEqual({
    level: "warn",
    msg: "memory adapter invalid export, using null",
    fields: { agent: "bad-mem", module: "memory-adapter.js" },
  });
});

async function createRoom(name: string): Promise<void> {
  const roomDir = join(roomsDir, name);
  await mkdir(join(roomDir, "sessions"), { recursive: true });
  await mkdir(join(roomDir, "staging"), { recursive: true });
  await writeFile(join(roomDir, "PREFACE.md"), "I am the primary boot file.", "utf-8");
  await writeFile(join(roomDir, "AGENTS.md"), "Session instructions live here.", "utf-8");
  await writeFile(
    join(roomDir, "config.yaml"),
    `
identity:
  name: ${name}
  label: ${name}
provider:
  type: claude
policy:
  allowedRoots: ["${join(roomDir, "staging")}"]
  readOnlyRoots: ["${roomDir}"]
session:
  defaultMode: plan
  autoModeOptIn: false
boot:
  gene: PREFACE.md
  soul: PREFACE.md
  sessionContext:
    - AGENTS.md
`,
    "utf-8",
  );
}
