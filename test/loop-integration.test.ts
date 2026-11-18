import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoopMode } from "../src/agents/loop";
import type { LoadedAgent } from "../src/agents/loader";
import type { Provider, ProviderChunk, ProviderRequest, ProviderResponse } from "../src/providers/interface";
import { SessionStore } from "../src/memory/session-store";
import { SessionManager } from "../src/session/manager";
import { NullMemoryAdapter } from "../src/memory/null-adapter";

let tempDir: string;

afterEach(() => {
  rmSync(tempDir ?? "", { recursive: true, force: true });
});

// Provider that returns a sequence of predefined responses
function mockProvider(responses: string[]): Provider {
  let i = 0;
  return {
    name: "claude",
    query(_req: ProviderRequest): Promise<ProviderResponse> {
      const content = responses[i] ?? '<DONE reason="no more responses" />';
      i++;
      return Promise.resolve({
        message: { role: "assistant", content },
      });
    },
  };
}

function mockAgent(): LoadedAgent {
  return {
    name: "test-agent",
    label: "Test Agent",
    roomDir: "/tmp",
    geneContent: "Core instructions.",
    soulContent: "You are a test agent.",
    soulPath: "/tmp/soul.md",
    sessionContextFiles: [],
    additionalContent: [],
    memoryAdapter: new NullMemoryAdapter(),
    config: {
      provider: { type: "claude", model: "claude-test", modeMap: {} },
      policy: { allowedRoots: [], readOnlyRoots: [], allowedTools: [] },
      session: { defaultMode: "auto", compactThreshold: 60000 },
      memory: undefined,
    },
  };
}

describe("runLoopMode integration", () => {
  test("terminates on DONE signal", async () => {
    tempDir = join(tmpdir(), `anima-loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const sessionStore = new SessionStore(join(tempDir, "sessions.db"));
    const sessionManager = new SessionManager({ store: sessionStore, maxTokens: 200000 });
    const turns: string[] = [];

    const result = await runLoopMode(
      mockAgent(),
      "complete the task",
      mockProvider([
        'Working on it.\n<LOOP reason="step 1 done, step 2 remaining" />',
        'All done.\n<DONE reason="task complete" />',
      ]),
      sessionManager,
      sessionStore,
      {
        maxIterations: 10,
        onTurn: (n, output, signal) => turns.push(`${n}:${signal.type}`),
      },
    );

    expect(result.exitReason).toBe("done");
    expect(result.iterations).toBe(2);
    expect(turns).toEqual(["1:loop", "2:done"]);

    sessionStore.close();
  });

  test("terminates on max iterations", async () => {
    tempDir = join(tmpdir(), `anima-loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const sessionStore = new SessionStore(join(tempDir, "sessions.db"));
    const sessionManager = new SessionManager({ store: sessionStore, maxTokens: 200000 });
    const turns: string[] = [];

    const infiniteProvider = mockProvider(
      Array.from({ length: 20 }, (_, i) => `<LOOP reason="step ${i + 1}" />`),
    );

    const result = await runLoopMode(
      mockAgent(),
      "never-ending task",
      infiniteProvider,
      sessionManager,
      sessionStore,
      {
        maxIterations: 3,
        onTurn: (n, _output, signal) => turns.push(`${n}:${signal.type}`),
      },
    );

    expect(result.exitReason).toBe("max_reached");
    expect(result.iterations).toBe(3);
    expect(turns.length).toBe(3);
    expect(turns.every(t => t.includes("loop"))).toBe(true);

    sessionStore.close();
  });

  test("terminates on abort signal (Ctrl-C)", async () => {
    tempDir = join(tmpdir(), `anima-loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const sessionStore = new SessionStore(join(tempDir, "sessions.db"));
    const sessionManager = new SessionManager({ store: sessionStore, maxTokens: 200000 });
    const turns: string[] = [];

    const controller = new AbortController();

    const countingProvider: Provider = {
      name: "claude",
      query(_req: ProviderRequest): Promise<ProviderResponse> {
        // abort after first response is fetched
        controller.abort();
        return Promise.resolve({
          message: { role: "assistant", content: '<LOOP reason="still going" />' },
        });
      },
    };

    const result = await runLoopMode(
      mockAgent(),
      "interruptible task",
      countingProvider,
      sessionManager,
      sessionStore,
      {
        maxIterations: 10,
        signal: controller.signal,
        onTurn: (n, _output, signal) => turns.push(`${n}:${signal.type}`),
      },
    );

    expect(result.exitReason).toBe("interrupted");
    expect(result.iterations).toBe(1);
    expect(turns).toHaveLength(1);

    sessionStore.close();
  });

  test("persists turns to session store", async () => {
    tempDir = join(tmpdir(), `anima-loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const sessionStore = new SessionStore(join(tempDir, "sessions.db"));
    const sessionManager = new SessionManager({ store: sessionStore, maxTokens: 200000 });

    const session = sessionManager.openSession("test-agent", "loop");

    await runLoopMode(
      mockAgent(),
      "the goal",
      mockProvider(['<DONE reason="done immediately" />']),
      sessionManager,
      sessionStore,
      { maxIterations: 5 },
    );

    const turns = sessionStore.getTurns(session.id);
    expect(turns.length).toBe(2); // user + assistant
    expect(turns[0].role).toBe("user");
    expect(turns[1].role).toBe("assistant");

    sessionStore.close();
  });
});
