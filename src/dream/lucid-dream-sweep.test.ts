import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LucidDreamSweep } from "./lucid-dream-sweep";
import type { AgentMemoryStore, AgentMemoryEntry } from "../memory/contract";
import type { Provider, ProviderRequest, ProviderResponse } from "../providers/interface";

let roomsDir: string;

beforeEach(() => {
  roomsDir = mkdtempSync(join(tmpdir(), "lucid-sweep-"));
  for (const agent of ["lena", "hana"]) {
    mkdirSync(join(roomsDir, agent), { recursive: true });
    writeFileSync(join(roomsDir, agent, "config.yaml"), "identity:\n  name: " + agent + "\n", "utf-8");
  }
});

afterEach(() => {
  rmSync(roomsDir, { recursive: true, force: true });
});

const fakeProvider: Provider = {
  name: "fake" as Provider["name"],
  async query(_req: ProviderRequest): Promise<ProviderResponse> {
    return { message: { role: "assistant", content: "reflection" } };
  },
};

function makeMemoryStoreSpy(): { store: AgentMemoryStore; calls: Omit<AgentMemoryEntry, "id" | "createdAt">[] } {
  const calls: Omit<AgentMemoryEntry, "id" | "createdAt">[] = [];
  const store: AgentMemoryStore = {
    async remember(entry) {
      calls.push(entry);
      return { ...entry, id: "fake-id", createdAt: new Date().toISOString() };
    },
    async recall() { return []; },
    async bootstrap() { return []; },
    async forget() {},
  };
  return { store, calls };
}

test("resolveMemoryStore, when provided, is called per agent and its store receives the reflection", async () => {
  const { store, calls } = makeMemoryStoreSpy();
  const resolvedFor: string[] = [];

  const sweep = new LucidDreamSweep();
  await sweep.run({
    roomsDir,
    resolveProvider: async () => fakeProvider,
    resolveMemoryStore: async (roomDir) => {
      resolvedFor.push(roomDir);
      return store;
    },
    prompt: "reflect",
  });

  expect(resolvedFor.sort()).toEqual([join(roomsDir, "hana"), join(roomsDir, "lena")]);
  expect(calls).toHaveLength(2);
  expect(calls.every((c) => c.content === "reflection")).toBe(true);
});

test("omitting resolveMemoryStore does not throw and the sweep still completes", async () => {
  const sweep = new LucidDreamSweep();
  await sweep.run({
    roomsDir,
    resolveProvider: async () => fakeProvider,
    prompt: "reflect",
  });

  const state = JSON.parse(
    await Bun.file(join(roomsDir, "staging", ".lucid-sweep-state.json")).text(),
  );
  expect(state.completed).toBe(true);
});
