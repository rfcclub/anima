import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSession } from "../src/agents/session";
import type { LoadedAgent } from "../src/agents/loader";
import { JsonlStore } from "../src/memory/jsonl-store";
import { executeTool, type ExecuteToolOptions } from "../src/tools/executor";

type ToolCall = Parameters<typeof executeTool>[0];
const runTool = (
  call: ToolCall,
  cwd?: string,
  agentName?: string,
  memoryStore?: ExecuteToolOptions["memoryStore"],
  contextEngine?: ExecuteToolOptions["contextEngine"],
) => executeTool(call, { cwd, agentName, memoryStore, contextEngine, policy: null });
import type { AgentMemoryStore, AgentMemoryEntry, RecallOptions, BootstrapOptions } from "../src/memory/contract";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/interface";

let tempDir: string;
let store: JsonlStore;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-mem-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  store = new JsonlStore(tempDir);
});

/* ------------------------------------------------------------------ */
/*  executor.ts — anima_* dispatch                                     */
/* ------------------------------------------------------------------ */

describe("executeTool — anima_remember", () => {
  test("dispatches to store.remember and returns id + createdAt", async () => {
    const memStore = mockMemoryStore();
    const result = await runTool(
      { id: "t1", name: "anima_remember", arguments: JSON.stringify({ content: "deploy at ~/deploy.sh", scope: "fact" }) },
      undefined,
      "bruno",
      memStore,
    );
    const parsed = JSON.parse(result);
    expect(parsed.id).toBeDefined();
    expect(parsed.createdAt).toBeDefined();
    expect(memStore._remembered.length).toBe(1);
    expect(memStore._remembered[0].content).toBe("deploy at ~/deploy.sh");
  });

  test("returns error JSON when no store provided", async () => {
    const result = await runTool(
      { id: "t2", name: "anima_remember", arguments: JSON.stringify({ content: "something" }) },
      undefined,
      "bruno",
      undefined,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("error");
    expect(parsed.message).toContain("memory store not available");
  });
});

describe("executeTool — anima_recall", () => {
  test("returns array of matching entries", async () => {
    const memStore = mockMemoryStore();
    memStore._recallResult = [
      entry("e1", "deploy script at ~/bin/deploy.sh"),
      entry("e2", "staging server at 192.168.1.10"),
    ];
    const result = await runTool(
      { id: "t3", name: "anima_recall", arguments: JSON.stringify({ query: "deploy" }) },
      undefined,
      "bruno",
      memStore,
    );
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].id).toBe("e1");
  });
});

describe("executeTool — anima_forget", () => {
  test("calls store.forget and returns ok", async () => {
    const memStore = mockMemoryStore();
    const result = await runTool(
      { id: "t4", name: "anima_forget", arguments: JSON.stringify({ id: "entry_abc" }) },
      undefined,
      "bruno",
      memStore,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("ok");
    expect(memStore._forgotten).toContain("entry_abc");
  });

  test("returns ok even if entry does not exist", async () => {
    const memStore = mockMemoryStore();
    const result = await runTool(
      { id: "t5", name: "anima_forget", arguments: JSON.stringify({ id: "nonexistent" }) },
      undefined,
      "bruno",
      memStore,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("ok");
  });
});

describe("executeTool — anima_update", () => {
  test("returns error when store does not support update (mock store)", async () => {
    const memStore = mockMemoryStore();
    const result = await runTool(
      { id: "t8", name: "anima_update", arguments: JSON.stringify({ id: "nonexistent", content: "new content" }) },
      undefined,
      "bruno",
      memStore,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("error");
  });
});

describe("executeTool — anima_context_*", () => {
  test("returns empty results with note when no context engine", async () => {
    const result = await runTool(
      { id: "t6", name: "anima_context_search", arguments: JSON.stringify({ query: "migration" }) },
      undefined,
      "bruno",
      undefined,
      undefined,
    );
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBe(0);
    expect(parsed.note).toContain("context engine not available");
  });

  test("anima_context_describe returns note without engine", async () => {
    const result = await runTool(
      { id: "t7", name: "anima_context_describe", arguments: "{}" },
      undefined,
      "bruno",
      undefined,
      undefined,
    );
    const parsed = JSON.parse(result);
    expect(parsed.note).toContain("context engine not available");
  });
});

/* ------------------------------------------------------------------ */
/*  session.ts — before_turn hook                                      */
/* ------------------------------------------------------------------ */

describe("AgentSession before_turn hook", () => {
  test("injects [Memory Context] from memoryStore.bootstrap when anima_* in allowedTools", async () => {
    const memStore = mockMemoryStore();
    memStore._bootstrapResult = [
      entry("b1", "User prefers Vietnamese responses"),
      entry("b2", "Deploy script at ~/deploy.sh"),
    ];

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
      agent: testAgent(["bash", "anima_remember", "anima_recall"]),
      message: "what is the deploy command?",
      sessionId: "s1",
      memoryStore: memStore,
    });

    expect(capturedSystem).toContain("[Memory Context]");
    expect(capturedSystem).toContain("User prefers Vietnamese responses");
    expect(capturedSystem).toContain("Deploy script at ~/deploy.sh");
  });

  test("skips injection when no anima_* tools in allowedTools", async () => {
    const memStore = mockMemoryStore();
    memStore._bootstrapResult = [entry("b1", "should not appear")];

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
      agent: testAgent(["bash", "read"]),
      message: "hello",
      sessionId: "s2",
      memoryStore: memStore,
    });

    expect(capturedSystem).not.toContain("[Memory Context]");
    expect(memStore._bootstrapCalled).toBe(false);
  });

  test("does not inject duplicate [Memory Context] if already present from adapter", async () => {
    const memStore = mockMemoryStore();
    memStore._bootstrapResult = [entry("b1", "bootstrap fact")];

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
      agent: testAgent(["anima_remember"]),
      message: "hello",
      sessionId: "s3",
      memoryStore: memStore,
      lifecycleContext: "[Memory Context]\n- pre-existing context",
    });

    // Count occurrences of [Memory Context]
    const count = (capturedSystem.match(/\[Memory Context\]/g) ?? []).length;
    expect(count).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function entry(id: string, content: string): AgentMemoryEntry {
  return { id, content, scope: "fact", tags: [], confidence: 0.8, source: "test", createdAt: new Date().toISOString() };
}

function mockMemoryStore(): AgentMemoryStore & {
  _remembered: Array<Omit<AgentMemoryEntry, "id" | "createdAt">>;
  _forgotten: string[];
  _recallResult: AgentMemoryEntry[];
  _bootstrapResult: AgentMemoryEntry[];
  _bootstrapCalled: boolean;
} {
  const remembered: Array<Omit<AgentMemoryEntry, "id" | "createdAt">> = [];
  const forgotten: string[] = [];
  let recallResult: AgentMemoryEntry[] = [];
  let bootstrapResult: AgentMemoryEntry[] = [];
  let bootstrapCalled = false;

  const s: AgentMemoryStore & {
    _remembered: typeof remembered;
    _forgotten: typeof forgotten;
    _recallResult: AgentMemoryEntry[];
    _bootstrapResult: AgentMemoryEntry[];
    _bootstrapCalled: boolean;
  } = {
    async remember(e) {
      remembered.push(e);
      return { ...e, id: `id-${remembered.length}`, createdAt: new Date().toISOString() };
    },
    async recall(_q: string, _opts?: RecallOptions) {
      return recallResult;
    },
    async bootstrap(_opts?: BootstrapOptions) {
      bootstrapCalled = true;
      return bootstrapResult;
    },
    async forget(id: string) {
      forgotten.push(id);
    },
    get _remembered() { return remembered; },
    get _forgotten() { return forgotten; },
    get _recallResult() { return recallResult; },
    set _recallResult(v: AgentMemoryEntry[]) { recallResult = v; },
    get _bootstrapResult() { return bootstrapResult; },
    set _bootstrapResult(v: AgentMemoryEntry[]) { bootstrapResult = v; },
    get _bootstrapCalled() { return bootstrapCalled; },
  };
  return s;
}

function provider(query?: (req: ProviderRequest) => Promise<ProviderResponse>): Provider {
  return {
    name: "claude",
    query: query ?? (async () => response("default")),
  };
}

function response(content: string): ProviderResponse {
  return { message: { role: "assistant", content } };
}

function testAgent(allowedTools: string[] = []): LoadedAgent {
  return {
    name: "bruno",
    label: "Bruno",
    roomDir: join(tempDir, "rooms", "bruno"),
    soulPath: "SOUL.md",
    geneContent: "Core instructions.",
    soulContent: "You are Bruno.",
    sessionContextFiles: [],
    additionalContent: [],
    config: {
      identity: { name: "bruno", label: "Bruno" },
      provider: { type: "claude" },
      policy: {
        allowedRoots: [],
        readOnlyRoots: [],
        allowedTools,
      },
      session: { defaultMode: "plan", autoModeOptIn: false },
      boot: { gene: "SOUL.md", soul: "SOUL.md", sessionContext: [] },
    },
  };
}
