import { expect, test } from "bun:test";
import { ModeRouter } from "../../src/providers/router";
import { OpenAIv1ChatProvider } from "../../src/providers/openai-v1-chat";
import { ProviderError, type Provider, type ProviderRequest } from "../../src/providers/interface";
import type { CircuitBreaker } from "../../src/providers/circuit-breaker";
import type { ModeMap } from "../../src/config/types";
import type { ProviderRegistry } from "../../src/providers/registry";

const modeMap: ModeMap = {
  chatting: ["model@first", "model@second"],
  programming: [], image: [], private: [], philosophy: [], creative: [],
};
const registry = {
  resolve(ref: string) {
    const id = ref.split("@")[1]!;
    return {
      provider: { id, label: id, api: "openai-completions", baseUrl: "https://mock.local/v1", apiKey: "mock-key", models: [{ id: "model" }] },
      model: { id: "model" },
    };
  },
} as unknown as ProviderRegistry;
const request = (signal: AbortSignal): ProviderRequest => ({
  agent: "fixture", mode: "auto", messages: [{ role: "user", content: "test" }], signal,
});

function setup(chain: boolean, behavior: (id: string) => Promise<void>, isOpen: () => Promise<boolean> = async () => false) {
  const calls: string[] = [];
  const failures: string[] = [];
  const successes: string[] = [];
  const breaker = {
    isOpen,
    isHalfOpen: async () => false,
    getState: async () => null,
    recordFailure: (id: string) => { failures.push(id); },
    recordSuccess: (id: string) => { successes.push(id); },
    recordModelSuccess: async (id: string) => { successes.push(id); },
  } as unknown as CircuitBreaker;
  const router = new ModeRouter(registry, modeMap, {
    ...(chain ? { providerConfig: { type: "first", model: "model", retry: 2, fallback: [{ type: "second", model: "model", retry: 1 }] } } : {}),
    breaker,
    meter: { ledger: { recordCall: () => {} } },
    createProvider: (id: string): Provider => ({
      name: id,
      async query() {
        calls.push(id);
        await behavior(id);
        return { message: { role: "assistant", content: "ok" } };
      },
    }),
  });
  return { router, calls, failures, successes };
}

for (const chain of [true, false]) {
  test(`SC-${chain ? "7" : "8"} abort does not retry or mark a provider failed in ${chain ? "the fallback chain" : "the mode map"}`, async () => {
    const controller = new AbortController();
    const t = setup(chain, async (id) => {
      if (id === "first") {
        controller.abort();
        throw new ProviderError("TIMEOUT", id, "cancelled");
      }
    });
    const outcome = await t.router.query(request(controller.signal), "chatting").then(() => "resolved", (error) => error.name);
    expect(t.calls).toEqual(["first"]);
    expect(t.failures).toEqual([]);
    expect(t.successes).toEqual([]);
    expect(outcome).toBe("AbortError");
  });

  test(`abort before a ${chain ? "fallback chain" : "mode map"} starts never calls a provider`, async () => {
    const controller = new AbortController();
    controller.abort();
    const t = setup(chain, async () => {});
    const outcome = await t.router.query(request(controller.signal), "chatting").then(() => "resolved", (error) => error.name);
    expect(t.calls).toEqual([]);
    expect(outcome).toBe("AbortError");
  });

  test(`abort while a ${chain ? "fallback chain" : "mode map"} checks the breaker never calls a provider`, async () => {
    const controller = new AbortController();
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const checking = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const t = setup(chain, async () => {}, async () => { entered(); await gate; return false; });
    const pending = t.router.query(request(controller.signal), "chatting").then(() => "resolved", (error) => error.name);
    await checking;
    controller.abort();
    release();
    const outcome = await pending;
    expect(t.calls).toEqual([]);
    expect(t.failures).toEqual([]);
    expect(outcome).toBe("AbortError");
  });

  test(`a ${chain ? "fallback chain" : "mode map"} discards a success returned after cancellation`, async () => {
    const controller = new AbortController();
    const t = setup(chain, async () => { controller.abort(); });
    const outcome = await t.router.query(request(controller.signal), "chatting").then(() => "resolved", (error) => error.name);
    expect(t.calls).toEqual(["first"]);
    expect(t.failures).toEqual([]);
    expect(t.successes).toEqual([]);
    expect(outcome).toBe("AbortError");
  });

  test(`a cancelled ${chain ? "fallback chain" : "mode map"} does not retry after an authorization error`, async () => {
    const controller = new AbortController();
    const t = setup(chain, async (id) => {
      if (id === "first") {
        controller.abort();
        throw new ProviderError("AUTH_ERROR", id, "denied");
      }
    });
    const outcome = await t.router.query(request(controller.signal), "chatting").then(() => "resolved", (error) => error.name);
    expect(t.calls).toEqual(["first"]);
    expect(t.failures).toEqual([]);
    expect(outcome).toBe("AbortError");
  });

  for (const [status, label] of [[401, "unauthorized"], [403, "forbidden"]] as const) {
    test(`a non-cancelled ${chain ? "fallback chain" : "mode map"} handles HTTP ${status} ${label} without retrying the rejected provider`, async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response("denied", { status })) as typeof fetch;
      try {
        const actualProvider = new OpenAIv1ChatProvider(registry.resolve("model@first").provider);
        const controller = new AbortController();
        const t = setup(chain, async (id) => {
          if (id === "first") await actualProvider.query(request(controller.signal));
        });
        const result = await t.router.query(request(controller.signal), "chatting");
        expect(t.calls).toEqual(["first", "second"]);
        expect(t.failures).toEqual([]);
        expect(result.message.content).toBe("ok");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
}
