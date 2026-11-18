import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSession } from "../src/agents/session";
import type { LoadedAgent } from "../src/agents/loader";
import { CrossingManager, type CrossingEntry } from "../src/continuity/crossing";
import { SessionLifecycle } from "../src/session/lifecycle";
import { JsonlStore } from "../src/memory/jsonl-store";
import type { MemoryAdapter, MemoryEntry, RecallOptions } from "../src/memory/adapter";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/interface";

let tempDir: string;
let store: JsonlStore;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-lifecycle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tempDir, "rooms", "cleo", "staging"), { recursive: true });
  store = new JsonlStore(tempDir);
});

test("onOpen fires once per agent/channel and prepares context", async () => {
  const calls = { load: 0, recall: 0, trust: 0 };
  const countingAdapter = memoryAdapter(async () => {
    calls.recall++;
    return [{ namespace: "cleo", content: "entity recall once", type: "fact", timestamp: now() }];
  });
  const lifecycle = new SessionLifecycle({
    loader: loader({ memoryAdapter: countingAdapter }),
    store,
    crossingManager: crossingManager({
      load: async () => {
        calls.load++;
        return crossing();
      },
    }),
    trustInitializer: {
      async initialize() {
        calls.trust++;
      },
    },
  });

  const first = await lifecycle.onOpen("cleo", "tg-1", "hello");
  const second = await lifecycle.onOpen("cleo", "tg-1", "hello again");

  expect(second.sessionId).toBe(first.sessionId);
  expect(calls).toEqual({ load: 1, recall: 1, trust: 1 });
  expect(first.systemContext).toContain("[Crossing Context]");
  expect(first.systemContext).toContain("carry this forward");
  expect(first.systemContext).toContain("[Memory Context]");
  expect(first.systemContext).toContain("entity recall once");
});

test("onClose triggers LightNap exactly once and writes crossing ledger", async () => {
  const lightNapCalls: unknown[] = [];
  const lifecycle = new SessionLifecycle({
    loader: loader(),
    store,
    crossingManager: new CrossingManager(),
    lightNap: {
      async run(options: unknown) {
        lightNapCalls.push(options);
      },
    } as any,
  });

  const opened = await lifecycle.onOpen("cleo", "tg-2", "start");
  store.append("cleo", {
    timestamp: now(),
    type: "assistant_message",
    sessionId: opened.sessionId,
    body: "learned an insight",
  });

  await lifecycle.onClose("cleo", "tg-2");
  await lifecycle.onClose("cleo", "tg-2");
  await Promise.resolve();

  expect(lightNapCalls.length).toBe(1);
  expect(existsSync(join(tempDir, "rooms", "cleo", "staging", "crossing.md"))).toBe(true);
  const events = store.readDate("cleo", new Date().toISOString().slice(0, 10));
  expect(events.filter((event) => event.type === "session_lifecycle_close")).toHaveLength(1);
});

test("AgentSession does not run LightNap mid-conversation", async () => {
  const session = new AgentSession({
    store,
    provider: provider(async () => response("learned an insight")),
    log: () => {},
  });

  await session.run({
    agent: agent(),
    message: "this contains an insight",
    sessionId: "s-mid",
  });
  await Promise.resolve();

  expect(existsSync(join(tempDir, "rooms", "cleo", "staging", "beams"))).toBe(false);
});

test("AgentSession injects lifecycle context into provider system prompt", async () => {
  let capturedSystem = "";
  const session = new AgentSession({
    store,
    provider: provider(async (req) => {
      capturedSystem = req.system ?? "";
      return response("ok");
    }),
    log: () => {},
  });

  await session.run({
    agent: agent(),
    message: "hello",
    sessionId: "s-context",
    lifecycleContext: "[Crossing Context]\n- from lifecycle",
  });

  expect(capturedSystem).toContain("[Crossing Context]");
  expect(capturedSystem).toContain("from lifecycle");
});

/* ---------- drain() awaits pending LightNap ---------- */

test("drain awaits pending LightNap before resolving", async () => {
  let lightNapResolved = false;
  const lifecycle = new SessionLifecycle({
    loader: loader(),
    store,
    crossingManager: new CrossingManager(),
    lightNap: {
      async run() {
        // Simulate async work
        await new Promise((r) => setTimeout(r, 50));
        lightNapResolved = true;
      },
    } as any,
  });

  const opened = await lifecycle.onOpen("cleo", "tg-drain", "test");
  store.append("cleo", {
    timestamp: now(),
    type: "assistant_message",
    sessionId: opened.sessionId,
    body: "test event",
  });

  // onClose schedules LightNap asynchronously but doesn't await it
  await lifecycle.onClose("cleo", "tg-drain");

  // drain() should wait for LightNap to finish
  await lifecycle.drain();

  expect(lightNapResolved).toBe(true);
});

test("drain resolves cleanly even with no pending LightNaps", async () => {
  const lifecycle = new SessionLifecycle({
    loader: loader(),
    store,
  });

  // Should not hang or throw
  await lifecycle.drain();
  // If we reach here, test passes
});

test("drain handles LightNap errors gracefully", async () => {
  let errorCaught = false;
  const lifecycle = new SessionLifecycle({
    loader: loader(),
    store,
    crossingManager: new CrossingManager(),
    lightNap: {
      async run() {
        throw new Error("LightNap crash");
      },
    } as any,
    log: (_level: string, _msg: string) => {
      errorCaught = true;
    },
  });

  const opened = await lifecycle.onOpen("cleo", "tg-drain-err", "test");
  store.append("cleo", {
    timestamp: now(),
    type: "assistant_message",
    sessionId: opened.sessionId,
    body: "test event",
  });

  await lifecycle.onClose("cleo", "tg-drain-err");
  // drain should not throw even though LightNap crashed
  await lifecycle.drain();

  // LightNap error was caught and logged
  expect(errorCaught).toBe(true);
});

function loader(agentOverrides?: Partial<LoadedAgent>) {
  return {
    async load() {
      return { ...agent(), ...agentOverrides };
    },
  } as any;
}

function crossingManager(overrides: Partial<CrossingManager>): CrossingManager {
  return Object.assign(new CrossingManager(), overrides);
}

function crossing(): CrossingEntry {
  return {
    sessionId: "prev",
    timestamp: now(),
    carriesForward: ["carry this forward"],
    unresolved: [],
    notes: "",
    status: "complete",
  };
}

function memoryAdapter(recall: (query: string, opts?: RecallOptions) => Promise<MemoryEntry[]>): MemoryAdapter {
  return {
    async recall(query: string, opts?: RecallOptions) {
      return recall(query, opts);
    },
    async store() {},
  };
}

function provider(query?: (req: ProviderRequest) => Promise<ProviderResponse>): Provider {
  return {
    name: "claude",
    query: query ?? (async () => response("ok")),
  };
}

function response(content: string): ProviderResponse {
  return {
    message: { role: "assistant", content },
  };
}

function agent(): LoadedAgent {
  return {
    name: "cleo",
    label: "Bodega Owner",
    roomDir: join(tempDir, "rooms", "cleo"),
    soulPath: "PREFACE.md",
    geneContent: "Core instructions.",
    soulContent: "You are Cleo.",
    sessionContextFiles: [{ path: "AGENTS.md", content: "Session context." }],
    additionalContent: [],
    memoryAdapter: memoryAdapter(async () => []),
    config: {
      identity: { name: "cleo", label: "Bodega Owner" },
      provider: { type: "claude" },
      policy: {
        allowedRoots: [join(tempDir, "rooms", "cleo", "staging")],
        readOnlyRoots: [join(tempDir, "rooms", "cleo", "mount")],
        allowedTools: [],
      },
      session: { defaultMode: "plan", autoModeOptIn: false },
      boot: { gene: "PREFACE.md", soul: "PREFACE.md", sessionContext: [{ path: "AGENTS.md" }] },
    },
  };
}

function now(): string {
  return new Date().toISOString();
}
