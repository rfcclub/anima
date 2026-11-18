/**
 * cartridge-worker-dispatch: the session-scoped model gateway an external worker
 * calls instead of holding a provider key. Real loopback listener, fake provider; no network beyond 127.0.0.1.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { createSessionGateway, type GatewayCall, type SessionGateway } from "../../src/work/gateway";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

const gateways: SessionGateway[] = [];
afterEach(async () => { for (const g of gateways.splice(0)) await g.stop(); });

const link = { workId: "w1", jobId: "job-1", claimId: "claim-1", sessionNo: 1 };

function fakeProvider(hold?: Promise<void>) {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    name: "pinned",
    async query(request: ProviderRequest): Promise<ProviderResponse> {
      requests.push(request);
      if (hold) {
        await Promise.race([hold, new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new Error("aborted"))))]);
      }
      return { message: { role: "assistant", content: "hello from the pinned model" }, usage: { input_tokens: 3, output_tokens: 5 } };
    },
  };
  return { provider, requests };
}

function open(over: Partial<Parameters<typeof createSessionGateway>[0]> & { provider: Provider }) {
  const calls: GatewayCall[] = [];
  const logs: string[] = [];
  const g = createSessionGateway({
    model: "deepseek-v4.1-flash", budget: 5, link, admit: () => true,
    onCall: (c) => calls.push(c), log: (line) => logs.push(line), ...over,
  });
  gateways.push(g);
  return { g, calls, logs };
}

const body = (model = "deepseek-v4.1-flash") => JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] });
const post = (g: SessionGateway, token: string | null, payload = body()) => fetch(`${g.url}/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) }, body: payload,
});

describe("session gateway (cartridge-worker-dispatch S4)", () => {
  test("gateway-only-model-access: loopback, token-gated, pinned to the work's model, tagged with the work link", async () => {
    const { provider, requests } = fakeProvider();
    const { g, calls, logs } = open({ provider });
    await g.start();
    expect(new URL(g.url).hostname).toBe("127.0.0.1");
    expect(g.token).toMatch(/^[A-Za-z0-9_-]{43,}$/);

    expect((await post(g, null)).status).toBe(401);
    expect((await post(g, "wrong-token")).status).toBe(401);
    expect((await post(g, g.token, body("another-model"))).status).toBe(400);
    expect(requests.length).toBe(0);

    const ok = await post(g, g.token);
    expect(ok.status).toBe(200);
    const json = await ok.json() as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]!.message.content).toBe("hello from the pinned model");
    expect(requests.length).toBe(1);
    expect([requests[0]!.model, requests[0]!.work]).toEqual(["deepseek-v4.1-flash", link]);
    expect(calls.map((c) => [c.status, c.link])).toEqual([["ok", link]]);
    expect(logs.join("\n")).not.toContain(g.token);
  });

  test("gateway-budget-and-revocation: in-flight calls count; lease loss refuses; revoke aborts and records uncertain", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { provider, requests } = fakeProvider(hold);
    let leased = true;
    const { g, calls } = open({ provider, budget: 2, admit: () => leased });
    await g.start();

    const first = post(g, g.token);
    const second = post(g, g.token);
    await Bun.sleep(50);
    expect(g.stats()).toEqual({ admitted: 2, inFlight: 2, revoked: false });
    expect((await post(g, g.token)).status).toBe(429);
    release();
    expect([(await first).status, (await second).status]).toEqual([200, 200]);
    expect((await post(g, g.token)).status).toBe(429);

    const fresh = fakeProvider(new Promise<void>(() => {}));
    const second2 = open({ provider: fresh.provider, budget: 5, admit: () => leased });
    await second2.g.start();
    leased = false;
    expect((await post(second2.g, second2.g.token)).status).toBe(409);
    expect(fresh.requests.length).toBe(0);
    leased = true;
    const pending = post(second2.g, second2.g.token);
    await Bun.sleep(50);
    second2.g.revoke();
    expect((await pending).status).toBe(503);
    expect(fresh.requests[0]!.signal?.aborted).toBe(true);
    expect(second2.calls.map((c) => c.status)).toEqual(["uncertain"]);
    expect((await post(second2.g, second2.g.token)).status).toBe(401);
    expect(second2.g.stats()).toEqual({ admitted: 1, inFlight: 0, revoked: true });
    expect(requests.length).toBe(2);
    expect(calls.map((c) => c.status)).toEqual(["ok", "ok"]);
  });

  // A malformed body must be refused before admission, not burn budget as a
  // provider failure.
  test("gateway-malformed-body: a structurally bad request is a 400 that neither admits nor records a call", async () => {
    const { provider, requests } = fakeProvider();
    const { g, calls } = open({ provider, budget: 1 });
    await g.start();
    const bad = [
      { model: "deepseek-v4.1-flash" },
      { model: "deepseek-v4.1-flash", messages: "hi" },
      { model: "deepseek-v4.1-flash", messages: [null] },
      { model: "deepseek-v4.1-flash", messages: [{ role: "robot", content: "hi" }] },
      { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: 7 }] },
      { model: "deepseek-v4.1-flash", messages: [{ role: "assistant", content: null, tool_calls: [{}] }] },
      { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], tools: [{}] },
      { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], tools: "x" },
    ];
    for (const payload of bad) expect((await post(g, g.token, JSON.stringify(payload))).status).toBe(400);
    expect(g.stats().admitted).toBe(0);
    expect(calls).toEqual([]);
    expect(requests.length).toBe(0);
    expect((await post(g, g.token)).status).toBe(200);
  });

  // OpenAI clients often send `tool_calls: null` / `tools: null`; those are valid.
  test("gateway-null-optional-fields: null tool_calls and tools are accepted like absent ones", async () => {
    const { provider, requests } = fakeProvider();
    const { g } = open({ provider });
    await g.start();
    const payload = JSON.stringify({
      model: "deepseek-v4.1-flash", tools: null,
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok", tool_calls: null }, { role: "user", content: "again" }],
    });
    expect((await post(g, g.token, payload)).status).toBe(200);
    expect(requests.length).toBe(1);
  });

  // A request whose body is still arriving when the gateway is revoked must not be admitted.
  test("gateway-revoke-during-body: revocation while the body is read refuses admission and never calls the provider", async () => {
    const { provider, requests } = fakeProvider();
    const { g, calls } = open({ provider });
    await g.start();
    let push!: (chunk: string) => void;
    let end!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        push = (chunk) => controller.enqueue(enc.encode(chunk));
        end = () => controller.close();
      },
    });
    const text = body();
    push(text.slice(0, 10));
    const pending = fetch(`${g.url}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${g.token}` }, body: stream,
      duplex: "half",
    } as RequestInit);
    await Bun.sleep(50);
    g.revoke();
    push(text.slice(10));
    end();
    expect((await pending).status).toBe(401);
    expect(requests.length).toBe(0);
    expect(g.stats().admitted).toBe(0);
    expect(calls).toEqual([]);
  });

  // A streamed provider that reports an error mid-stream is a failed call.
  test("gateway-stream-error-chunk: an error chunk from a streaming provider is a 502 recorded as failed", async () => {
    const provider: Provider = {
      name: "pinned",
      query: (async function* () {
        yield { type: "text", content: "partial" };
        yield { type: "error", error: "upstream broke" };
      }) as unknown as Provider["query"],
    };
    const { g, calls } = open({ provider });
    await g.start();
    expect((await post(g, g.token)).status).toBe(502);
    expect(calls.map((c) => c.status)).toEqual(["failed"]);
  });

  // A streamed completion must carry the provider's tool calls, or the worker's tool loop stops.
  test("gateway-stream-tool-calls: stream:true serializes tool calls as OpenAI deltas ending in tool_calls", async () => {
    const provider: Provider = {
      name: "pinned",
      async query(): Promise<ProviderResponse> {
        return {
          message: { role: "assistant", content: "" },
          tool_calls: [
            { id: "call_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
            { id: "call_2", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
          ],
        };
      },
    };
    const { g } = open({ provider });
    await g.start();
    const payload = JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }] });
    const res = await post(g, g.token, payload);
    expect(res.status).toBe(200);
    const events = (await res.text()).split("\n\n").filter((e) => e.startsWith("data: ") && !e.includes("[DONE]"))
      .map((e) => JSON.parse(e.slice(6)) as { choices: Array<{ delta: { tool_calls?: Array<Record<string, unknown>> }; finish_reason: string | null }> });
    const deltas = events.flatMap((e) => e.choices[0]!.delta.tool_calls ?? []);
    expect(deltas).toEqual([
      { index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } },
      { index: 1, id: "call_2", type: "function", function: { name: "bash", arguments: "{\"cmd\":\"ls\"}" } },
    ]);
    expect(events.at(-1)!.choices[0]!.finish_reason).toBe("tool_calls");
  });

  // The worker is untrusted, so the request body is capped.
  test("gateway-body-cap: a request body over the cap is refused without admission", async () => {
    const { provider, requests } = fakeProvider();
    const { g } = open({ provider });
    await g.start();
    const huge = JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "x".repeat(9 * 1024 * 1024) }] });
    const res = await post(g, g.token, huge).catch(() => null);
    expect(res === null || res.status === 413).toBe(true);
    expect(requests.length).toBe(0);
    expect(g.stats().admitted).toBe(0);
  });
});
