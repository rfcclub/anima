/**
 * ModeRouter — fallback chain tests
 * Covers: retry loop + fallback, breaker skip, half-open trial, chain exhausted.
 */

import { test, expect, describe, afterEach, beforeAll, afterAll } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModeRouter } from "../../src/providers/router";
import { CircuitBreaker } from "../../src/providers/circuit-breaker";
import { ProviderError, type Provider, type ProviderRequest, type ProviderResponse } from "../../src/providers/interface";
import type { ModeMap } from "../../src/config/types";

// --- Helpers ---

const TEST_DIR = join(homedir(), ".anima", "__test_router");

function testBreakerPath(name: string): string {
  return join(TEST_DIR, `breaker_${name}_${Date.now()}.json`);
}

/** Clean up the default breaker.json if it has leftover state from other tests. */
function cleanupDefaultBreaker(): void {
  const defaultPath = join(homedir(), ".anima", "breaker.json");
  try { unlinkSync(defaultPath); } catch { /* */ }
  try { unlinkSync(defaultPath + ".tmp"); } catch { /* */ }
}

beforeAll(() => {
  // Ensure test dir exists
  try { require("node:fs").mkdirSync(TEST_DIR, { recursive: true }); } catch { /* */ }
  cleanupDefaultBreaker();
});

afterAll(() => {
  cleanupDefaultBreaker();
});

// --- Mocks ---

function makeRegistry(providers: Array<{ id: string; models?: string[] }>) {
  const map = new Map();
  for (const p of providers) {
    const def = {
      id: p.id,
      label: p.id,
      baseUrl: "https://mock.local/v1",
      api: "openai-completions" as const,
      apiKey: "mock-key",
      models: (p.models ?? ["mock-model"]).map((id) => ({ id })),
    };
    map.set(p.id, def);
  }
  return {
    get: (id: string) => map.get(id),
    list: () => [...map.values()],
    resolve: (ref: string) => {
      const at = ref.lastIndexOf("@");
      const modelId = ref.slice(0, at);
      const providerId = ref.slice(at + 1);
      const provider = map.get(providerId);
      if (!provider) throw new Error(`unknown provider: ${providerId}`);
      const model = provider.models.find((m: any) => m.id === modelId);
      if (!model) throw new Error(`unknown model: ${modelId}`);
      return { provider, model };
    },
  };
}

function mockProvider(sideEffects: Array<"success" | ProviderError>): Provider {
  let callIdx = 0;
  return {
    name: "mock",
    async query(_req: ProviderRequest): Promise<ProviderResponse> {
      const effect = sideEffects[callIdx] ?? sideEffects[sideEffects.length - 1];
      callIdx++;
      if (effect === "success") {
        return {
          message: { role: "assistant", content: "ok" },
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      throw effect;
    },
  };
}

const modeMap: ModeMap = {
  chatting: [],
  programming: [],
  image: [],
  private: [],
  philosophy: [],
  creative: [],
};

function defaultReq(): ProviderRequest {
  return {
    messages: [{ role: "user", content: "hello" }],
    agent: "test",
    mode: "auto",
  };
}

/** Create a fresh breaker + cleanup helper for a test. */
function freshBreaker(name: string): { breaker: CircuitBreaker; cleanup: () => void } {
  const bp = testBreakerPath(name);
  return {
    breaker: new CircuitBreaker(bp),
    cleanup: () => {
      try { unlinkSync(bp); } catch { /* */ }
      try { unlinkSync(bp + ".tmp"); } catch { /* */ }
    },
  };
}

// --- Tests ---

describe("ModeRouter — Fallback Chain", () => {
  test("primary succeeds on first attempt", async () => {
    const { breaker, cleanup } = freshBreaker("first-attempt");
    try {
      const registry = makeRegistry([{ id: "minimax" }]);
      const router = new ModeRouter(registry as any, modeMap, {
        providerConfig: { type: "minimax", model: "mock-model", retry: 3 },
        breaker,
        createProvider: () => mockProvider(["success"]),
      });
      const result = await router.query(defaultReq(), "chatting");
      expect(result.message.content).toBe("ok");
    } finally { cleanup(); }
  });

  test("primary succeeds on 2nd retry after transient failure", async () => {
    const { breaker, cleanup } = freshBreaker("retry-success");
    try {
      const registry = makeRegistry([{ id: "minimax" }]);
      const router = new ModeRouter(registry as any, modeMap, {
        providerConfig: { type: "minimax", model: "mock-model", retry: 3 },
        breaker,
        createProvider: () =>
          mockProvider([
            new ProviderError("SERVER_ERROR", "minimax", "timeout"),
            "success",
          ]),
      });
      const result = await router.query(defaultReq(), "chatting");
      expect(result.message.content).toBe("ok");
    } finally { cleanup(); }
  });

  test("primary fails all retries → fallback succeeds", async () => {
    const { breaker, cleanup } = freshBreaker("fallback-wins");
    try {
      const registry = makeRegistry([
        { id: "minimax" },
        { id: "exampleprov" },
      ]);
      const router = new ModeRouter(registry as any, modeMap, {
        providerConfig: {
          type: "minimax",
          model: "mock-model",
          retry: 2,
          fallback: [{ model: "mock-model", type: "exampleprov", retry: 2 }],
        },
        breaker,
        createProvider: (id: string) => {
          if (id === "minimax") {
            return mockProvider([
              new ProviderError("SERVER_ERROR", "minimax", "fail1"),
              new ProviderError("SERVER_ERROR", "minimax", "fail2"),
            ]);
          }
          return mockProvider(["success"]);
        },
      });
      const result = await router.query(defaultReq(), "chatting");
      expect(result.message.content).toBe("ok");
    } finally { cleanup(); }
  });

  test("chain exhausted → ProviderError with trail", async () => {
    const { breaker, cleanup } = freshBreaker("exhausted");
    try {
      const registry = makeRegistry([
        { id: "minimax" },
        { id: "exampleprov" },
      ]);
      const router = new ModeRouter(registry as any, modeMap, {
        providerConfig: {
          type: "minimax",
          model: "mock-model",
          retry: 1,
          fallback: [{ model: "mock-model", type: "exampleprov", retry: 1 }],
        },
        breaker,
        createProvider: () =>
          mockProvider([new ProviderError("SERVER_ERROR", "mock", "fail")]),
      });
      await expect(router.query(defaultReq(), "chatting")).rejects.toThrow(
        "all providers exhausted",
      );
    } finally { cleanup(); }
  });
});

describe("ModeRouter — Circuit Breaker Integration", () => {
  test("open breaker → skip provider → go to fallback", async () => {
    const { breaker, cleanup } = freshBreaker("open-skip");
    try {
      const registry = makeRegistry([
        { id: "minimax" },
        { id: "exampleprov" },
      ]);

      // Pre-open breaker for minimax
      breaker.recordFailure("minimax");
      breaker.recordFailure("minimax"); // opens

      const router = new ModeRouter(registry as any, modeMap, {
        providerConfig: {
          type: "minimax",
          model: "mock-model",
          retry: 2,
          fallback: [{ model: "mock-model", type: "exampleprov", retry: 2 }],
        },
        breaker,
        createProvider: (id: string) => {
          if (id === "minimax") {
            return mockProvider([new ProviderError("SERVER_ERROR", "minimax", "should not reach")]);
          }
          return mockProvider(["success"]);
        },
      });

      const result = await router.query(defaultReq(), "chatting");
      expect(result.message.content).toBe("ok");
    } finally { cleanup(); }
  });

  test("half-open breaker → trial success → breaker closes", async () => {
    const { breaker, cleanup } = freshBreaker("half-open-ok");
    try {
      const registry = makeRegistry([{ id: "minimax" }]);

      // Setup OPEN but past cooldown → half_open
      const pastReset = new Date(Date.now() - 1_000).toISOString();
      const pastOpen = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      breaker.write("minimax", {
        state: "open",
        failureCount: 2,
        openedAt: pastOpen,
        resetAt: pastReset,
      });

      const router = new ModeRouter(registry as any, modeMap, {
        providerConfig: { type: "minimax", model: "mock-model", retry: 2 },
        breaker,
        createProvider: () => mockProvider(["success"]),
      });

      const result = await router.query(defaultReq(), "chatting");
      expect(result.message.content).toBe("ok");

      // Breaker should now be closed
      const state = await breaker.getState("minimax");
      expect(state?.state).toBe("closed");
      expect(state?.failureCount).toBe(0);
    } finally { cleanup(); }
  });

  test("half-open breaker → trial fails → breaker re-opens", async () => {
    const { breaker, cleanup } = freshBreaker("half-open-fail");
    try {
      const registry = makeRegistry([{ id: "exampleprov" }]);

      // Setup OPEN but past cooldown → half_open
      const pastReset = new Date(Date.now() - 1_000).toISOString();
      const pastOpen = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      breaker.write("exampleprov", {
        state: "open",
        failureCount: 2,
        openedAt: pastOpen,
        resetAt: pastReset,
      });

      const router = new ModeRouter(registry as any, modeMap, {
        providerConfig: { type: "exampleprov", model: "mock-model", retry: 1 },
        breaker,
        createProvider: () =>
          mockProvider([new ProviderError("SERVER_ERROR", "exampleprov", "still down")]),
      });

      await expect(router.query(defaultReq(), "chatting")).rejects.toThrow(
        "all providers exhausted",
      );

      // Breaker should be re-opened (not closed, not half_open)
      const state = await breaker.getState("exampleprov");
      expect(state?.state).toBe("open");
      expect(state!.failureCount).toBeGreaterThanOrEqual(2);
      // resetAt should be extended (~5 min from now)
      const newResetAt = new Date(state!.resetAt).getTime();
      expect(newResetAt).toBeGreaterThan(Date.now() + 4.9 * 60 * 1000);
    } finally { cleanup(); }
  });

  test("auth error skips retries (non-retryable)", async () => {
    const { breaker, cleanup } = freshBreaker("auth-skip");
    try {
      const registry = makeRegistry([
        { id: "minimax" },
        { id: "exampleprov" },
      ]);
      const router = new ModeRouter(registry as any, modeMap, {
        providerConfig: {
          type: "minimax",
          model: "mock-model",
          retry: 3,
          fallback: [{ model: "mock-model", type: "exampleprov", retry: 1 }],
        },
        breaker,
        createProvider: (id: string) => {
          if (id === "minimax") {
            return mockProvider([new ProviderError("AUTH_ERROR", "minimax", "bad key")]);
          }
          return mockProvider(["success"]);
        },
      });

      const result = await router.query(defaultReq(), "chatting");
      expect(result.message.content).toBe("ok");
      // minimax breaker should NOT be opened for auth errors
      const state = await breaker.getState("minimax");
      expect(state).toBeNull();
    } finally { cleanup(); }
  });
});

describe("ModeRouter — Backward Compat", () => {
  test("agent without fallback config uses modeMap (existing behavior)", async () => {
    const { breaker, cleanup } = freshBreaker("backward-compat");
    try {
      const registry = makeRegistry([{ id: "exampleprov", models: ["glm-5.1"] }]);
      const compatModeMap: ModeMap = {
        chatting: ["glm-5.1@exampleprov"],
        programming: [],
        image: [],
        private: [],
        philosophy: [],
        creative: [],
      };

      const router = new ModeRouter(registry as any, compatModeMap, {
        breaker,
        createProvider: () => mockProvider(["success"]),
      });

      const result = await router.query(defaultReq(), "chatting");
      expect(result.message.content).toBe("ok");
    } finally { cleanup(); }
  });
});
