import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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

/** A store holding one supported pattern, so every agent has an inbox to judge. */
function makeMemoryStoreSpy(): { store: AgentMemoryStore; calls: Omit<AgentMemoryEntry, "id" | "createdAt">[] } {
  return seededStore([
    { id: "a", content: "I judge sources before trusting them", tags: ["craft"], confidence: 0.9 },
    { id: "b", content: "I judge sources before trusting them", tags: ["craft"], confidence: 0.85 },
    { id: "c", content: "I judge sources before trusting them", tags: ["craft"], confidence: 0.8 },
  ]);
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
  // the memory store keeps the run's audit note, never the model's whole response
  expect(calls).toHaveLength(2);
  expect(calls.every((c) => c.content.includes("Reflection audit"))).toBe(true);
  expect(calls.some((c) => c.content === "reflection")).toBe(false);
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

const throwingProvider: Provider = {
  name: "fake" as Provider["name"],
  async query(_req: ProviderRequest): Promise<ProviderResponse> {
    throw new Error("provider unavailable");
  },
};

const statePath = () => join(roomsDir, "staging", ".lucid-sweep-state.json");
const readState = async () => JSON.parse(await Bun.file(statePath()).text());

/** Provider that fails only for the named agents' rooms. */
function failingFor(...failing: string[]) {
  return async (roomDir: string): Promise<Provider> =>
    failing.some((a) => roomDir.endsWith("/" + a)) ? throwingProvider : fakeProvider;
}

test("a failing agent does not stop the agents after it, and the failure is recorded", async () => {
  const { store, calls } = makeMemoryStoreSpy();
  const sweep = new LucidDreamSweep();
  await sweep.run({
    roomsDir,
    resolveProvider: failingFor("hana"),
    resolveMemoryStore: async () => store,
    prompt: "reflect",
  });

  // "hana" sorts before "lena": under the old break-on-first-failure behaviour lena was never reached.
  expect(calls).toHaveLength(1);
  const state = await readState();
  expect(state.completed).toBe(true);
  expect(state.failedAgents).toEqual(["hana"]);
});

test("the next run starts fresh and retries the agent that failed", async () => {
  const sweep = new LucidDreamSweep();
  await sweep.run({ roomsDir, resolveProvider: failingFor("hana"), prompt: "reflect" });

  const { store, calls } = makeMemoryStoreSpy();
  await sweep.run({ roomsDir, resolveProvider: async () => fakeProvider, resolveMemoryStore: async () => store, prompt: "reflect" });

  expect(calls).toHaveLength(2); // both agents reflect again, including the one that failed before
  const state = await readState();
  expect(state.completed).toBe(true);
  expect(state.failedAgents).toEqual([]);
});

test("an unfinished state aged just under one week is still discarded: the weekly slot always starts fresh", async () => {
  mkdirSync(join(roomsDir, "staging"), { recursive: true });
  writeFileSync(
    statePath(),
    JSON.stringify({
      startedAt: new Date(Date.now() - (7 * 24 * 3600 * 1000 - 5 * 60 * 1000)).toISOString(),
      completedAgents: ["hana"],
      currentAgent: "lena",
    }),
    "utf-8",
  );
  const { store, calls } = makeMemoryStoreSpy();
  await new LucidDreamSweep().run({ roomsDir, resolveProvider: async () => fakeProvider, resolveMemoryStore: async () => store, prompt: "reflect" });

  expect(calls).toHaveLength(2); // hana is retried, not skipped
});

test("an unfinished state with an unparseable or future startedAt is discarded, not resumed forever", async () => {
  for (const startedAt of ["garbage", new Date(Date.now() + 3 * 3600 * 1000).toISOString()]) {
    mkdirSync(join(roomsDir, "staging"), { recursive: true });
    writeFileSync(statePath(), JSON.stringify({ startedAt, completedAgents: ["hana"], currentAgent: "lena" }), "utf-8");
    const { store, calls } = makeMemoryStoreSpy();
    await new LucidDreamSweep().run({ roomsDir, resolveProvider: async () => fakeProvider, resolveMemoryStore: async () => store, prompt: "reflect" });
    expect(calls).toHaveLength(2); // hana is not skipped
  }
});

test("an unfinished state from the same day is resumed", async () => {
  mkdirSync(join(roomsDir, "staging"), { recursive: true });
  writeFileSync(
    statePath(),
    JSON.stringify({ startedAt: new Date(Date.now() - 3600 * 1000).toISOString(), completedAgents: ["hana"], currentAgent: "lena" }),
    "utf-8",
  );
  const { store, calls } = makeMemoryStoreSpy();
  await new LucidDreamSweep().run({ roomsDir, resolveProvider: async () => fakeProvider, resolveMemoryStore: async () => store, prompt: "reflect" });

  expect(calls).toHaveLength(1); // only lena runs; hana already finished in this run
});

test("an outcome recorded for a removed agent neither blocks finalization nor appears in the failure summary", async () => {
  mkdirSync(join(roomsDir, "staging"), { recursive: true });
  writeFileSync(
    statePath(),
    JSON.stringify({
      startedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      completedAgents: ["hana"],
      failedAgents: ["gone"],
      currentAgent: "lena",
    }),
    "utf-8",
  );
  await new LucidDreamSweep().run({ roomsDir, resolveProvider: async () => fakeProvider, prompt: "reflect" });

  const state = await readState();
  expect(state.completed).toBe(true);
  expect(state.failedAgents).toEqual([]);
});

test("a checkpoint write error does not turn a finished reflection into a failed one", async () => {
  const { store, calls } = makeMemoryStoreSpy();
  // While the first agent reflects, replace the state file with a directory so the checkpoint write fails.
  const sabotage: Provider = {
    name: "fake" as Provider["name"],
    async query(): Promise<ProviderResponse> {
      rmSync(statePath(), { force: true });
      mkdirSync(statePath(), { recursive: true });
      return { message: { role: "assistant", content: "reflection" } };
    },
  };
  let first = true;
  const logged: string[] = [];
  const realError = console.error;
  console.error = (line: unknown) => { logged.push(String(line)); };
  try {
    await new LucidDreamSweep().run({
      roomsDir,
      resolveProvider: async () => {
        if (first) { first = false; return sabotage; }
        return fakeProvider;
      },
      resolveMemoryStore: async () => store,
      prompt: "reflect",
    });
  } finally {
    console.error = realError;
  }

  expect(calls).toHaveLength(2); // both agents reflected
  // the write error is reported as a checkpoint error, never as a failed reflection
  expect(logged.some((l) => l.includes("checkpoint write failed"))).toBe(true);
  expect(logged.some((l) => l.includes("lucid dream sweep failed for agent"))).toBe(false);
});

test("an unfinished state older than one week is discarded instead of resumed", async () => {
  mkdirSync(join(roomsDir, "staging"), { recursive: true });
  writeFileSync(
    statePath(),
    JSON.stringify({
      startedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
      completedAgents: ["hana"],
      currentAgent: "lena",
    }),
    "utf-8",
  );
  const { store, calls } = makeMemoryStoreSpy();
  await new LucidDreamSweep().run({ roomsDir, resolveProvider: async () => fakeProvider, resolveMemoryStore: async () => store, prompt: "reflect" });

  expect(calls).toHaveLength(2); // hana is not skipped: the stale state no longer counts
});

test("consecutive failing runs raise the failure streak recorded for that agent", async () => {
  const sweep = new LucidDreamSweep();
  for (let i = 0; i < 3; i++) {
    await sweep.run({ roomsDir, resolveProvider: failingFor("hana"), prompt: "reflect" });
  }
  expect((await readState()).failureStreak).toEqual({ hana: 3 });

  await sweep.run({ roomsDir, resolveProvider: async () => fakeProvider, prompt: "reflect" });
  expect((await readState()).failureStreak).toEqual({});
});

/** A memory store whose bootstrap() returns the given entries, recording remember() calls. */
function seededStore(entries: Array<{ id: string; content: string; tags: string[]; confidence: number }>): {
  store: AgentMemoryStore;
  calls: Omit<AgentMemoryEntry, "id" | "createdAt">[];
} {
  const calls: Omit<AgentMemoryEntry, "id" | "createdAt">[] = [];
  const store: AgentMemoryStore = {
    async remember(entry) {
      calls.push(entry);
      return { ...entry, id: "fake-id", createdAt: new Date().toISOString() };
    },
    async recall() { return []; },
    async bootstrap() {
      return entries.map((e, index) => ({
        ...e, scope: "observation" as const, source: "pulse",
        createdAt: `2026-01-01T00:00:0${index}.000Z`,
      }));
    },
    async forget() {},
  };
  return { store, calls };
}

test("extraction fills the inbox from the agent's memory and the reflection turn judges it", async () => {
  const { store, calls } = seededStore([
    { id: "a", content: "I judge sources before trusting them", tags: ["craft"], confidence: 0.9 },
    { id: "b", content: "I judge sources before trusting them", tags: ["craft"], confidence: 0.85 },
    { id: "c", content: "I judge sources before trusting them", tags: ["craft"], confidence: 0.8 },
  ]);

  await new LucidDreamSweep().run({
    roomsDir,
    resolveProvider: async () => fakeProvider,
    resolveMemoryStore: async () => store,
    prompt: "reflect",
  });

  // the inbox now exists for each agent, and only the audit note reaches memory
  const inbox = await Bun.file(join(roomsDir, "hana", "staging", "INBOX.md")).text();
  expect(inbox).toContain("I judge sources before trusting them");
  expect(calls).toHaveLength(2);
  expect(calls.every((c) => c.content.includes("Reflection audit"))).toBe(true);
  expect(calls.some((c) => c.content === "reflection")).toBe(false);
});

test("without proposals there is nothing to judge and the inbox says so", async () => {
  const seen: string[] = [];
  const probing: Provider = {
    name: "fake" as Provider["name"],
    async query(req: ProviderRequest): Promise<ProviderResponse> {
      seen.push(String(req.messages[0]?.content ?? ""));
      return { message: { role: "assistant", content: "reflection" } };
    },
  };
  const { store } = seededStore([
    { id: "a", content: "one mention", tags: ["weather"], confidence: 0.9 },
  ]);

  await new LucidDreamSweep().run({
    roomsDir,
    resolveProvider: async () => probing,
    resolveMemoryStore: async () => store,
    prompt: "reflect",
  });

  const inbox = await Bun.file(join(roomsDir, "lena", "staging", "INBOX.md")).text();
  expect(inbox).toContain("(no proposals this pass)");
  // with nothing to judge no reflection turn is started at all
  expect(seen).toHaveLength(0);
});

test("a reflection turn that fails is recorded as a failed agent, and its writes are rolled back", async () => {
  const { store } = seededStore([
    { id: "a", content: "I judge sources before trusting them", tags: ["craft"], confidence: 0.9 },
    { id: "b", content: "I judge sources before trusting them", tags: ["craft"], confidence: 0.85 },
    { id: "c", content: "I judge sources before trusting them", tags: ["craft"], confidence: 0.8 },
  ]);
  let turn = 0;
  const halfThenFail: Provider = {
    name: "fake" as Provider["name"],
    async query(): Promise<ProviderResponse> {
      if (turn++ % 2 === 0) {
        return {
          message: { role: "assistant", content: null },
          tool_calls: [{
            id: "call-0",
            name: "write",
            arguments: JSON.stringify({ path: "SOUL.md", content: "- half applied\n" }),
          }],
        };
      }
      throw new Error("provider went away");
    },
  };

  await new LucidDreamSweep().run({
    roomsDir,
    resolveProvider: async () => halfThenFail,
    resolveMemoryStore: async () => store,
    prompt: "reflect",
  });

  expect((await readState()).failedAgents).toEqual(["hana", "lena"]);
  expect(existsSync(join(roomsDir, "lena", "SOUL.md"))).toBe(false);
});
