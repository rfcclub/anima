import { beforeEach, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LucidDreamSweep } from "../../src/dream/lucid-dream-sweep";
import type { Provider, ProviderRequest } from "../../src/providers/interface";

let tempDir: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-lucid-sweep-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.HOME = tempDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
});

function seedAgent(roomsDir: string, name: string) {
  mkdirSync(join(roomsDir, name), { recursive: true });
  writeFileSync(join(roomsDir, name, "config.yaml"), `identity:\n  name: ${name}\n  label: Test\n`);
}

function makeProvider(response: string, capture?: { requests: ProviderRequest[] }): Provider {
  return {
    name: "test",
    query: async (req: ProviderRequest) => {
      capture?.requests.push(req);
      return { message: { role: "assistant", content: response } };
    },
  };
}

test("lucid dream sweep runs for all agents sequentially", async () => {
  const roomsDir = join(tempDir, "rooms");
  seedAgent(roomsDir, "cleo");
  seedAgent(roomsDir, "milo");

  const capture = { requests: [] as ProviderRequest[] };
  const sweep = new LucidDreamSweep();
  await sweep.run({
    roomsDir,
    resolveProvider: async () => makeProvider("swept reflection", capture),
    prompt: "review your inbox",
  });

  expect(capture.requests.length).toBe(2);
  for (const agent of ["cleo", "milo"]) {
    const dreamsDir = join(roomsDir, agent, "staging", "dreams");
    const files = existsSync(dreamsDir) ? readdirSync(dreamsDir) : [];
    expect(files.length).toBe(1);
    const content = readFileSync(join(dreamsDir, files[0]), "utf-8");
    expect(content).toContain("swept reflection");
  }
});

test("lucid dream sweep passes the given prompt to each agent", async () => {
  const roomsDir = join(tempDir, "rooms");
  seedAgent(roomsDir, "cleo");

  const capture = { requests: [] as ProviderRequest[] };
  const sweep = new LucidDreamSweep();
  await sweep.run({
    roomsDir,
    resolveProvider: async () => makeProvider("ok", capture),
    prompt: "read staging/INBOX.md and decide",
  });

  const userMsg = capture.requests[0].messages[0].content as string;
  expect(userMsg).toContain("read staging/INBOX.md and decide");
});

test("lucid dream sweep resumes after crash, skipping completed agents", async () => {
  const roomsDir = join(tempDir, "rooms");
  seedAgent(roomsDir, "cleo");
  seedAgent(roomsDir, "milo");

  const stagingDir = join(roomsDir, "staging");
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(
    join(stagingDir, ".lucid-sweep-state.json"),
    JSON.stringify({ startedAt: new Date().toISOString(), completedAgents: ["cleo"], currentAgent: "" }),
  );

  const capture = { requests: [] as ProviderRequest[] };
  const sweep = new LucidDreamSweep();
  await sweep.run({
    roomsDir,
    resolveProvider: async () => makeProvider("resumed", capture),
    prompt: "review",
  });

  expect(capture.requests.length).toBe(1);
  expect(capture.requests[0].agent).toBe("milo");
});

test("lucid dream sweep starts fresh when previous run completed", async () => {
  const roomsDir = join(tempDir, "rooms");
  seedAgent(roomsDir, "cleo");

  const stagingDir = join(roomsDir, "staging");
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(
    join(stagingDir, ".lucid-sweep-state.json"),
    JSON.stringify({ completed: true, completedAt: new Date().toISOString() }),
  );

  const capture = { requests: [] as ProviderRequest[] };
  const sweep = new LucidDreamSweep();
  await sweep.run({
    roomsDir,
    resolveProvider: async () => makeProvider("fresh run", capture),
    prompt: "review",
  });

  expect(capture.requests.length).toBe(1);
  expect(capture.requests[0].agent).toBe("cleo");
});

test("lucid dream sweep logs and stops on a failing agent, without throwing", async () => {
  const roomsDir = join(tempDir, "rooms");
  seedAgent(roomsDir, "cleo");
  seedAgent(roomsDir, "milo");

  const capture = { requests: [] as ProviderRequest[] };
  const sweep = new LucidDreamSweep();

  const result = await sweep.run({
    roomsDir,
    resolveProvider: async (roomDir: string) => {
      if (roomDir.endsWith("cleo")) throw new Error("provider unavailable");
      return makeProvider("should not reach milo", capture);
    },
    prompt: "review",
  });
  expect(result).toBeUndefined();

  expect(capture.requests.length).toBe(0);

  const statePath = join(roomsDir, "staging", ".lucid-sweep-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  expect(state.completedAgents).toEqual([]);
});
