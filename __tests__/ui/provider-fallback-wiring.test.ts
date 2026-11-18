/**
 * ui/server.ts — createProviderForType must route registry-backed providers
 * through ModeRouter (fallback chain + circuit breaker), not call the
 * provider directly. Regression test for /api/talk/:agent bypassing fallback
 * entirely (a provider outage would otherwise take down every agent on
 * that provider because ui/server.ts called provider.query() directly).
 */

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderForType } from "../../src/ui/services/providers";
import { ProviderError, type Provider, type ProviderRequest, type ProviderResponse } from "../../src/providers/interface";
import type { ProviderConfig } from "../../src/config/types";

function makeRegistry(providers: Array<{ id: string; models?: string[] }>) {
  const map = new Map();
  for (const p of providers) {
    map.set(p.id, {
      id: p.id,
      label: p.id,
      baseUrl: "https://mock.local/v1",
      api: "openai-completions" as const,
      apiKey: "mock-key",
      models: (p.models ?? ["mock-model"]).map((id) => ({ id })),
    });
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
  } as any;
}

function mockProvider(effect: "success" | ProviderError): Provider {
  return {
    name: "mock",
    async query(_req: ProviderRequest): Promise<ProviderResponse> {
      if (effect === "success") {
        return { message: { role: "assistant", content: "ok from backup" }, usage: { input_tokens: 1, output_tokens: 1 } };
      }
      throw effect;
    },
  };
}

const breakerDir = mkdtempSync(join(tmpdir(), "anima-ui-fallback-"));
afterAll(() => rmSync(breakerDir, { recursive: true, force: true }));

function testBreakerPath(): string {
  return join(breakerDir, `breaker_ui_wiring_${Date.now()}_${Math.random()}.json`);
}

describe("createProviderForType — registry-backed providers use ModeRouter fallback", () => {
  test("falls back to the configured backup provider when the primary returns a server error", async () => {
    const registry = makeRegistry([{ id: "opencode-go" }, { id: "exampleprov" }]);
    const providerConfig: ProviderConfig = {
      type: "opencode-go",
      model: "mock-model",
      fallback: [{ type: "exampleprov", model: "mock-model" }],
    };
    let calls = 0;
    const provider = await createProviderForType(providerConfig, {
      registry,
      breakerPath: testBreakerPath(),
      createProvider: (providerId) => {
        calls++;
        if (providerId === "opencode-go") {
          return mockProvider(new ProviderError("SERVER_ERROR", "opencode-go", "Internal server error"));
        }
        return mockProvider("success");
      },
    });

    const result = await provider.query({ messages: [{ role: "user", content: "hi" }], agent: "test", mode: "auto" });
    expect("message" in result && result.message.content).toBe("ok from backup");
    expect(calls).toBeGreaterThan(1);
  });

  test("non-registry provider types (claude/gemini) are unaffected", async () => {
    const registry = makeRegistry([]);
    const provider = await createProviderForType({ type: "claude" as any }, { registry });
    expect(provider.name).toBeDefined();
  });
});
