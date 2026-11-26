import { expect, test } from "bun:test";
import type { ModeMap } from "../../src/config/types";
import { CircuitBreaker, type BreakerState } from "../../src/providers/circuit-breaker";
import type { Provider } from "../../src/providers/interface";
import type { ProviderRegistry } from "../../src/providers/registry";
import { ModeRouter } from "../../src/providers/router";

test("SC-9 abort during success bookkeeping neither resets the breaker nor returns a response", async () => {
  const controller = new AbortController();
  let entered = () => {};
  let release = () => {};
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let resets = 0;

  class DelayedBreaker extends CircuitBreaker {
    override async isOpen(): Promise<boolean> { return false; }
    override async isHalfOpen(): Promise<boolean> { return false; }
    override async getState(): Promise<BreakerState> {
      entered();
      await gate;
      return { state: "closed", failureCount: 1, openedAt: new Date().toISOString(), resetAt: new Date().toISOString() };
    }
    override recordSuccess(): void { resets++; }
  }

  const registry = {
    resolve: () => ({ provider: { id: "first" }, model: { id: "model" } }),
  } as unknown as ProviderRegistry;
  const modes: ModeMap = { chatting: [], programming: [], image: [], private: [], philosophy: [], creative: [] };
  const provider: Provider = {
    name: "synthetic",
    async query() { return { message: { role: "assistant", content: "late answer" } }; },
  };
  const router = new ModeRouter(registry, modes, {
    providerConfig: { type: "first", model: "model", retry: 1 },
    breaker: new DelayedBreaker(),
    meter: { ledger: { recordCall: () => {} } },
    createProvider: () => provider,
  });
  const pending = router.query({
    agent: "fixture", mode: "auto", messages: [{ role: "user", content: "test" }], signal: controller.signal,
  }, "chatting").then(() => "resolved", (error) => error.name);

  try {
    await reading;
    controller.abort();
    release();
    const outcome = await pending;
    expect({ outcome, resets }).toEqual({ outcome: "AbortError", resets: 0 });
  } finally {
    release();
  }
});

test("success bookkeeping still resets a failure count without cancellation", async () => {
  let resets = 0;
  class CountingBreaker extends CircuitBreaker {
    override async getState(): Promise<BreakerState> {
      return { state: "closed", failureCount: 1, openedAt: new Date().toISOString(), resetAt: new Date().toISOString() };
    }
    override recordSuccess(): void { resets++; }
  }
  await new CountingBreaker().recordModelSuccess("first", new AbortController().signal);
  expect(resets).toBe(1);
});
