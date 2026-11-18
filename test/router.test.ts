import { expect, test } from "bun:test";
import type { ModeMap } from "../src/config/types";
import { ProviderError, type Provider, type ProviderRequest, type ProviderResponse } from "../src/providers/interface";
import { ModeRouter } from "../src/providers/router";
import { ProviderRegistry } from "../src/providers/registry";

const modeMap: ModeMap = {
  chatting: ["glm-5.1@exampleprov"],
  programming: ["glm-5.1@exampleprov", "kimi-k2p6@exampleprov"],
  image: ["glm-5.1@exampleprov"],
  private: ["glm-5.1@exampleprov"],
  philosophy: ["glm-5.1@exampleprov"],
  creative: ["glm-5.1@exampleprov"],
};

test("resolve uses per-agent override for a mode and global map otherwise", async () => {
  const router = new ModeRouter(await registry(), modeMap, {
    modeMap: {
      programming: ["kimi-k2p6@exampleprov"],
    },
    createProvider: fakeProviderFactory(),
  });

  expect(router.resolve("programming")).toEqual(["kimi-k2p6@exampleprov"]);
  expect(router.resolve("chatting")).toEqual(["glm-5.1@exampleprov"]);
});

test("query returns first successful model without trying the rest", async () => {
  const calls: string[] = [];
  const router = new ModeRouter(await registry(), modeMap, {
    createProvider: fakeProviderFactory({
      "glm-5.1": async (req) => {
        calls.push(req.model ?? "");
        return response("first");
      },
      "kimi-k2p6": async (req) => {
        calls.push(req.model ?? "");
        return response("second");
      },
    }),
  });

  const result = await router.query(request(), "programming");

  expect(result.message.content).toBe("first");
  expect(calls).toEqual(["glm-5.1"]);
});

test("query falls back on retryable provider errors", async () => {
  const calls: string[] = [];
  const router = new ModeRouter(await registry(), modeMap, {
    createProvider: fakeProviderFactory({
      "glm-5.1": async (req) => {
        calls.push(req.model ?? "");
        throw new ProviderError("RATE_LIMITED", "exampleprov", "rate limited");
      },
      "kimi-k2p6": async (req) => {
        calls.push(req.model ?? "");
        return response("fallback");
      },
    }),
  });

  const result = await router.query(request(), "programming");

  expect(result.message.content).toBe("fallback");
  expect(calls).toEqual(["glm-5.1", "kimi-k2p6"]);
});

test("query skips the rest of a provider after AUTH_ERROR", async () => {
  const calls: string[] = [];
  const router = new ModeRouter(await registry(), {
    ...modeMap,
    programming: ["glm-5.1@exampleprov", "kimi-k2p6@exampleprov", "gpt-5.5@openai"],
  }, {
    createProvider: fakeProviderFactory({
      "glm-5.1": async (req) => {
        calls.push(`${req.model}@exampleprov`);
        throw new ProviderError("AUTH_ERROR", "exampleprov", "bad key");
      },
      "kimi-k2p6": async (req) => {
        calls.push(`${req.model}@exampleprov`);
        return response("should be skipped");
      },
      "gpt-5.5": async (req) => {
        calls.push(`${req.model}@openai`);
        return response("other provider");
      },
    }),
  });

  const result = await router.query(request(), "programming");

  expect(result.message.content).toBe("other provider");
  expect(calls).toEqual(["glm-5.1@exampleprov", "gpt-5.5@openai"]);
});

test("query throws ProviderError when all providers are exhausted", async () => {
  const router = new ModeRouter(await registry(), modeMap, {
    createProvider: fakeProviderFactory({
      "glm-5.1": async () => {
        throw new ProviderError("SERVER_ERROR", "exampleprov", "down");
      },
      "kimi-k2p6": async () => {
        throw new ProviderError("QUOTA_EXHAUSTED", "exampleprov", "quota");
      },
    }),
  });

  const err = await router.query(request(), "programming").catch((e) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err.message).toContain("all providers exhausted");
  // failure trail is included in the error message
  expect(err.message).toContain("glm-5.1@exampleprov");
  expect(err.message).toContain("SERVER_ERROR");
});

test("end-to-end: fallback to second provider when first returns 429 via real HTTP", async () => {
  // Spin up two fake OpenAI-compatible HTTP servers
  const primaryServer = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const fallbackServer = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ message: { role: "assistant", content: "fallback response" }, finish_reason: "stop", index: 0 }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  try {
    const primaryUrl = `http://127.0.0.1:${primaryServer.port}/v1`;
    const fallbackUrl = `http://127.0.0.1:${fallbackServer.port}/v1`;

    const reg = await ProviderRegistry.load(new URL("./fixtures/router-providers.d", import.meta.url).pathname);
    const router = new ModeRouter(reg, modeMap, {
      createProvider: (id) => {
        const { OpenAICompatProvider } = require("../src/providers/openai-compat");
        const baseUrl = id === "exampleprov" ? primaryUrl : fallbackUrl;
        return new OpenAICompatProvider({ id, label: id, baseUrl, api: "openai-completions", apiKey: "test", models: [{ id: "glm-5.1" }, { id: "kimi-k2p6" }] });
      },
    });

    // glm-5.1@exampleprov (primary) → 429 → kimi-k2p6@exampleprov (primary) → 429 → no openai in chatting mode
    // Use programming mode which has both exampleprov models then falls through
    // exampleprov → 429 (primary fails), openai → 200 (fallback succeeds)
    const modeMapWithFallback: ModeMap = {
      ...modeMap,
      programming: ["glm-5.1@exampleprov", "gpt-5.5@openai"],
    };
    const routerWithFallback = new ModeRouter(reg, modeMapWithFallback, {
      createProvider: (id) => {
        const { OpenAICompatProvider } = require("../src/providers/openai-compat");
        const baseUrl = id === "exampleprov" ? primaryUrl : fallbackUrl;
        return new OpenAICompatProvider({ id, label: id, baseUrl, api: "openai-completions", apiKey: "test", models: [{ id: "glm-5.1" }, { id: "gpt-5.5" }] });
      },
    });

    const result = await routerWithFallback.query(request(), "programming");
    expect(result.message.content).toBe("fallback response");
  } finally {
    primaryServer.stop(true);
    fallbackServer.stop(true);
  }
});

async function registry(): Promise<ProviderRegistry> {
  return ProviderRegistry.load(new URL("./fixtures/router-providers.d", import.meta.url).pathname);
}

function request(): ProviderRequest {
  return {
    agent: "eli",
    mode: "edit",
    messages: [{ role: "user", content: "hello" }],
  };
}

function response(content: string): ProviderResponse {
  return { message: { role: "assistant", content } };
}

function fakeProviderFactory(handlers: Record<string, (req: ProviderRequest) => Promise<ProviderResponse>> = {}): (providerId: string) => Provider {
  return (providerId: string) => ({
    name: providerId,
    async query(req: ProviderRequest): Promise<ProviderResponse> {
      const model = req.model ?? "";
      return handlers[model]?.(req) ?? response(`${model}@${providerId}`);
    },
  });
}
