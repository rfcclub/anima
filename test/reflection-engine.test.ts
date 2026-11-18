import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AgentSession } from "../src/agents/session";
import { createReflectionProvider, ObservationStore, TickRunner, parseReflectionAction, type ReflectionAction } from "../src/continuity/reflection-engine";
import { JsonlGardenEventStore } from "../src/garden/event-store";
import { createGardenEvent } from "../src/garden/events";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/interface";

class FakeProvider implements Provider {
  readonly name = "fake";
  calls: ProviderRequest[] = [];

  constructor(private readonly content: string) {}

  async query(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(req);
    return {
      message: { role: "assistant", content: this.content },
    };
  }
}

/** the reflection engine reaches other agents through a messenger, not MeshBus. */
class FakeMessenger {
  knocks: Array<{ agentId: string; intent: string }> = [];
  sent: Array<{ fromAgent: string; targetAgent: string; content: string }> = [];

  knock(agentId: string, intent: string): boolean {
    this.knocks.push({ agentId, intent });
    return true;
  }

  async send(fromAgent: string, targetAgent: string, content: string): Promise<void> {
    this.sent.push({ fromAgent, targetAgent, content });
  }
}

class FakeNarrativeStore {
  flags: Array<{ key: string; value: string; agentId: string }> = [];
  counters: Array<{ key: string; agentId: string; delta: number }> = [];
  threads: Array<Record<string, unknown>> = [];

  setMark(key: string, value: string, agentId: string): void {
    this.flags.push({ key, value, agentId });
  }

  incrementCounter(key: string, agentId: string, delta = 1): number {
    this.counters.push({ key, agentId, delta });
    return this.counters.filter((counter) => counter.key === key).length;
  }

  recordThread(thread: Record<string, unknown>): void {
    this.threads.push(thread);
  }
}

function runnerWith(deps: {
  provider?: Provider;
  messenger?: FakeMessenger;
  narrativeStore?: FakeNarrativeStore;
  eventStore?: JsonlGardenEventStore;
} = {}): TickRunner {
  const store = {
    record() {},
  } as unknown as ObservationStore;
  return new TickRunner(
    "bruno",
    { name: "bruno", urgencyThreshold: 3 },
    AgentSession,
    "/tmp/anima-reflection-test-rooms",
    store,
    { ...deps, now: () => 1234567890 },
  );
}

const urgentContext = {
  soul: "Bruno is attentive and kind.",
  memories: ["Lena asked for follow-up."],
  currentState: "in-room",
  inboxCount: 0,
  knocked: false,
  knockIntent: null,
  activityDigests: [],
  visitorTraces: [],
  discoveries: [],
};

describe("reflection engine LLM decide", () => {
  test("creates provider-backed decider from agent provider config", async () => {
    const providersDir = join(tmpdir(), `anima-reflection-providers-${randomUUID()}`);
    mkdirSync(providersDir, { recursive: true });
    writeFileSync(join(providersDir, "fake.yaml"), [
      "id: fake",
      "label: Fake",
      "baseUrl: http://127.0.0.1",
      "api: openai-completions",
      "apiKey: test",
      "sharedSafe: true",
      "models:",
      "  - id: cheap",
      "    label: Cheap",
      "",
    ].join("\n"));

    const inner = new FakeProvider(JSON.stringify({ type: "rest" }));
    const provider = await createReflectionProvider(
      { name: "bruno", provider: { type: "fake", model: "cheap" } },
      {
        providersDir,
        createProvider: () => inner,
      },
    );

    expect(provider).not.toBeNull();
    await provider!.query({
      agent: "bruno",
      mode: "plan",
      messages: [{ role: "user", content: "decide" }],
    });

    expect(inner.calls[0]?.model).toBe("cheap");
    expect(provider?.sharedSafe).toBe(true);
  });

  test("uses injected provider output when urgency reaches threshold", async () => {
    const provider = new FakeProvider(JSON.stringify({
      type: "post-agora",
      content: "I should check on Lena.",
      tags: ["reflection"],
    }));
    const runner = runnerWith({ provider });

    const action = await (runner as any).decide(urgentContext, 5, 3) as ReflectionAction;

    expect(provider.calls).toHaveLength(1);
    expect(action).toEqual({
      type: "post-agora",
      content: "I should check on Lena.",
      tags: ["reflection"],
    });
  });

  test("falls back safely when provider output is invalid JSON", async () => {
    const provider = new FakeProvider("not json");
    const runner = runnerWith({ provider });

    const action = await (runner as any).decide(urgentContext, 5, 3) as ReflectionAction;

    expect(provider.calls).toHaveLength(1);
    expect(action).toEqual({ type: "rest" });
  });
});

describe("reflection engine real actions", () => {
  test("message-agent sends to the target agent through the messenger and records narrative thread", async () => {
    const messenger = new FakeMessenger();
    const narrativeStore = new FakeNarrativeStore();
    const runner = runnerWith({ messenger, narrativeStore });

    const observation = await (runner as any).act({
      type: "message-agent",
      targetId: "lena",
      content: "Are you awake?",
    } satisfies ReflectionAction);

    expect(observation).toContain("messaged lena");
    expect(messenger.sent).toEqual([{ fromAgent: "bruno", targetAgent: "lena", content: "Are you awake?" }]);
    expect(messenger.knocks).toEqual([]);
    expect(narrativeStore.threads[0]).toMatchObject({
      fromAgent: "bruno",
      toAgent: "lena",
      label: "message-agent",
      value: "Are you awake?",
    });
  });

  test("post-agora records narrative state", async () => {
    const narrativeStore = new FakeNarrativeStore();
    const runner = runnerWith({ narrativeStore });

    const observation = await (runner as any).act({
      type: "post-agora",
      content: "The castle is quiet.",
      tags: ["reflection"],
    } satisfies ReflectionAction);

    expect(observation).toContain("posted to Agora");
    expect(narrativeStore.flags[0]).toEqual({
      key: "bruno:last-agora-post",
      value: "1234567890",
      agentId: "bruno",
    });
    expect(narrativeStore.threads[0]).toMatchObject({
      fromAgent: "bruno",
      toAgent: "agora",
      label: "post-agora",
      value: "The castle is quiet.",
    });
  });

  test("record updates narrative tick counters and last action", () => {
    const narrativeStore = new FakeNarrativeStore();
    const runner = runnerWith({ narrativeStore });

    (runner as any).record(urgentContext, 5, 3, {
      type: "post-agora",
      content: "The castle is quiet.",
      tags: ["reflection"],
    } satisfies ReflectionAction, "posted to Agora");

    expect(narrativeStore.counters[0]).toEqual({
      key: "bruno:tick-count",
      agentId: "bruno",
      delta: 1,
    });
    expect(narrativeStore.flags[0]).toEqual({
      key: "bruno:last-action",
      value: "post-agora:1234567890",
      agentId: "bruno",
    });
  });
});

describe("EVALUATE — urgency scoring (1 inbox message = 3 points)", () => {
  test("1 inbox message → score 3, meets threshold", async () => {
    const runner = runnerWith();
    const ctx = { ...urgentContext, inboxCount: 1, knocked: false };
    const { score, threshold } = (runner as any).evaluate(ctx);
    expect(score).toBe(3);
    expect(score >= threshold).toBe(true);
  });

  test("2 inbox messages → capped at 5", async () => {
    const runner = runnerWith();
    const ctx = { ...urgentContext, inboxCount: 2, knocked: false };
    const { score } = (runner as any).evaluate(ctx);
    expect(score).toBe(5);
  });

  test("0 inbox, no knock → score 0, rest", async () => {
    const runner = runnerWith();
    const ctx = { ...urgentContext, inboxCount: 0, knocked: false };
    const { score, threshold } = (runner as any).evaluate(ctx);
    expect(score).toBe(0);
    expect(score >= threshold).toBe(false);
  });
});

describe("ORIENT — memories from garden event store", () => {
  function makeEvent(agentId: string, type: any, payload: unknown) {
    return createGardenEvent({
      id: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      agentId,
      instanceId: agentId,
      runtime: "test",
      project: "anima",
      payload,
    });
  }

  test("returns memories filtered to this agent, formatted", async () => {
    const tempDir = join(tmpdir(), `anima-orient-memories-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    const store = new JsonlGardenEventStore(join(tempDir, "events.jsonl"));
    await store.append(makeEvent("bruno", "TASK_STARTED", { task: "wire orient" }));
    await store.append(makeEvent("lena", "TASK_STARTED", { task: "unrelated" }));

    const runner = runnerWith({ eventStore: store });
    const ctx = await (runner as any).orient();

    expect(ctx.memories).toHaveLength(1);
    expect(ctx.memories[0]).toContain("TASK_STARTED");
    expect(ctx.memories[0]).toContain("wire orient");
    expect(ctx.memories[0]).not.toContain("unrelated");
  });

  test("returns empty memories when no store injected (backward compat)", async () => {
    const runner = runnerWith();
    const ctx = await (runner as any).orient();
    expect(ctx.memories).toEqual([]);
  });

  test("returns empty memories when store file does not exist", async () => {
    const tempDir = join(tmpdir(), `anima-orient-missing-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    const store = new JsonlGardenEventStore(join(tempDir, "events.jsonl"));

    const runner = runnerWith({ eventStore: store });
    const ctx = await (runner as any).orient();
    expect(ctx.memories).toEqual([]);
  });
});

// ── castle-social-meetings: parse convene/join/speak actions ──────────────
describe("meeting action parsing", () => {
  test("SC-012: parses convene-meeting with topic + agenda + invite", () => {
    const a = parseReflectionAction(JSON.stringify({
      type: "convene-meeting",
      topic: "blocker-sync",
      agenda: "unblock the deploy",
      invite: ["lena", "sam"],
    }));
    expect(a).toEqual({ type: "convene-meeting", topic: "blocker-sync", agenda: "unblock the deploy", invite: ["lena", "sam"], stakes: "normal" });
  });

  test("SC-013: parses join-meeting + speak", () => {
    expect(parseReflectionAction(JSON.stringify({ type: "join-meeting", meetingId: "m-1" })))
      .toEqual({ type: "join-meeting", meetingId: "m-1" });
    expect(parseReflectionAction(JSON.stringify({ type: "speak", meetingId: "m-1", close: true })))
      .toEqual({ type: "speak", meetingId: "m-1", close: true });
  });

  test("SC-014: rejects missing topic / meetingId", () => {
    expect(parseReflectionAction(JSON.stringify({ type: "convene-meeting" }))).toBeNull();
    expect(parseReflectionAction(JSON.stringify({ type: "speak" }))).toBeNull();
  });
});
