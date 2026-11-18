/**
 * cost-ledger-accuracy: the metering wrapper.
 * Fake leaves and an in-memory ledger only — no real provider, no ~/.anima.
 */

import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { TokenLedger } from "../../src/cost/ledger";
import { meterProvider, isMetered } from "../../src/cost/meter";
import type { Provider, ProviderChunk, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

function setup(start = Date.parse("2026-10-22T12:00:00.000Z")) {
  const db = new Database(":memory:");
  const ledger = new TokenLedger(db);
  let t = start;
  const errors: unknown[] = [];
  const opts = { ledger, now: () => t, newId: (() => { let n = 0; return () => `call-${++n}`; })(), onError: (e: unknown) => { errors.push(e); } };
  return { db, ledger, opts, errors, tick: (ms: number) => { t += ms; } };
}

const req = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  agent: "bruno",
  sessionId: "sess-1",
  mode: "chatting" as ProviderRequest["mode"],
  messages: [{ role: "user", content: "hi" }],
  ...over,
});

const response = (usage?: ProviderResponse["usage"]): ProviderResponse => ({ message: { role: "assistant", content: "ok" }, usage });

function promiseLeaf(result: () => Promise<ProviderResponse>, name = "claude"): Provider {
  return { name, query: () => result() };
}

function streamLeaf(chunks: ProviderChunk[], name = "claude"): Provider {
  return {
    name,
    query: () => (async function* () { for (const c of chunks) yield c; })(),
  };
}

const parents = (db: Database) => db.query("SELECT * FROM provider_calls ORDER BY call_id").all() as any[];
const details = (db: Database) => db.query("SELECT * FROM token_usage ORDER BY id").all() as any[];

describe("meterProvider: Promise leaves", () => {
  test("a successful query writes 1 parent and 1 detail with agent, session, backend, latency and ok status", async () => {
    const s = setup();
    const leaf = promiseLeaf(async () => { s.tick(120); return response({ input_tokens: 200, output_tokens: 100, cache_read_tokens: 800, cache_write_tokens: 0, model: "claude-sonnet-4-6", cache_categories_reported: true }); });
    const out = await meterProvider(leaf, s.opts).query(req()) as ProviderResponse;
    expect(out.message.content).toBe("ok");
    expect(parents(s.db)).toHaveLength(1);
    expect(parents(s.db)[0]).toMatchObject({ call_id: "call-1", agent_id: "bruno", session_id: "sess-1", backend: "claude", started_at: "2026-10-22T12:00:00.000Z", latency_ms: 120, status: "ok", coverage: "complete" });
    expect(details(s.db)).toHaveLength(1);
    expect(details(s.db)[0]).toMatchObject({ call_id: "call-1", usage_version: 2, model: "claude-sonnet-4-6", input_tokens: 200, output_tokens: 100, cache_read_tokens: 800, cache_write_tokens: 0 });
  });

  test("a rejecting leaf writes status error with unknown usage and the same error reaches the caller", async () => {
    const s = setup();
    const boom = new Error("upstream 500");
    const leaf = promiseLeaf(async () => { s.tick(30); throw boom; });
    await expect(meterProvider(leaf, s.opts).query(req()) as Promise<unknown>).rejects.toBe(boom);
    expect(parents(s.db)[0]).toMatchObject({ status: "error", coverage: "unknown", latency_ms: 30 });
    expect(details(s.db)[0]).toMatchObject({ model: "unknown", input_tokens: null, output_tokens: null });
  });

  test("a leaf that throws synchronously is recorded and rethrown", () => {
    const s = setup();
    const boom = new Error("sync");
    const leaf: Provider = { name: "claude", query: () => { throw boom; } };
    expect(() => meterProvider(leaf, s.opts).query(req())).toThrow(boom);
    expect(parents(s.db)[0]).toMatchObject({ status: "error" });
  });

  test("a response without usage is ok with unknown coverage and NULL counts", async () => {
    const s = setup();
    await meterProvider(promiseLeaf(async () => response(undefined)), s.opts).query(req());
    expect(parents(s.db)[0]).toMatchObject({ status: "ok", coverage: "unknown" });
    expect(details(s.db)[0]).toMatchObject({ input_tokens: null, cache_write_tokens: null });
  });

  test("the model is the served model, else the requested one, else unknown", async () => {
    const s = setup();
    const m = meterProvider(promiseLeaf(async () => response({ input_tokens: 1, output_tokens: 1 })), s.opts);
    await m.query(req({ model: "requested-model" }));
    await m.query(req());
    expect(details(s.db).map((d) => d.model)).toEqual(["requested-model", "unknown"]);
  });

  test("a request with no session uses the explicit path id", async () => {
    const s = setup();
    const m = meterProvider(promiseLeaf(async () => response({ input_tokens: 1, output_tokens: 1 })), { ...s.opts, path: "compactor" });
    await m.query(req({ sessionId: undefined }));
    expect(parents(s.db)[0]).toMatchObject({ session_id: null, path_id: "compactor" });
  });

  test("an elapsed time that would be negative is stored as 0", async () => {
    const s = setup();
    const leaf = promiseLeaf(async () => { s.tick(-500); return response({ input_tokens: 1, output_tokens: 1 }); });
    await meterProvider(leaf, s.opts).query(req());
    expect(parents(s.db)[0].latency_ms).toBe(0);
  });

  test("a result with several models writes 1 parent and one detail per model, and no aggregate detail", async () => {
    const s = setup();
    const leaf = promiseLeaf(async () => response({
      input_tokens: 30, output_tokens: 12, cache_read_tokens: 0, cache_write_tokens: 0, cache_categories_reported: true,
      models: [
        { model: "claude-sonnet-4-6", input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 },
        { model: "claude-haiku-4-5", input_tokens: 20, output_tokens: 7, cache_read_tokens: 0, cache_write_tokens: 0 },
      ],
    }));
    await meterProvider(leaf, s.opts).query(req());
    expect(parents(s.db)).toHaveLength(1);
    expect(details(s.db).map((d) => [d.model, d.input_tokens, d.output_tokens])).toEqual([["claude-sonnet-4-6", 10, 5], ["claude-haiku-4-5", 20, 7]]);
  });

  test("input that includes the cache is stored uncached while the caller's response is untouched", async () => {
    const s = setup();
    const raw = { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 800, input_includes_cache: true, cache_categories_reported: true };
    const out = await meterProvider(promiseLeaf(async () => response({ ...raw })), s.opts).query(req()) as ProviderResponse;
    expect(out.usage?.input_tokens).toBe(1000);
    expect(details(s.db)[0]).toMatchObject({ input_tokens: 200, cache_read_tokens: 800, output_tokens: 100 });
  });
});

describe("meterProvider: streaming leaves", () => {
  async function drain(gen: AsyncGenerator<ProviderChunk>) { const out: ProviderChunk[] = []; for await (const c of gen) out.push(c); return out; }

  test("a completed stream writes 1 parent and 1 detail from the last usage chunk", async () => {
    const s = setup();
    const leaf = streamLeaf([{ type: "text", content: "a" }, { type: "text", content: "b", usage: { input_tokens: 5, output_tokens: 6, cache_read_tokens: 0, cache_write_tokens: 0, cache_categories_reported: true, model: "m1" } }]);
    const chunks = await drain(meterProvider(leaf, s.opts).query(req()) as AsyncGenerator<ProviderChunk>);
    expect(chunks.map((c) => c.content)).toEqual(["a", "b"]);
    expect(parents(s.db)).toHaveLength(1);
    expect(parents(s.db)[0]).toMatchObject({ status: "ok", coverage: "complete" });
    expect(details(s.db)[0]).toMatchObject({ model: "m1", input_tokens: 5, output_tokens: 6 });
  });

  test("an unstarted stream is not a call", () => {
    const s = setup();
    meterProvider(streamLeaf([{ type: "text", content: "a" }]), s.opts).query(req());
    expect(parents(s.db)).toHaveLength(0);
  });

  test("an explicit return() after the first chunk settles once as ok with unknown usage", async () => {
    const s = setup();
    const gen = meterProvider(streamLeaf([{ type: "text", content: "a" }, { type: "text", content: "b" }]), s.opts).query(req()) as AsyncGenerator<ProviderChunk>;
    await gen.next();
    await gen.return(undefined);
    expect(parents(s.db)).toHaveLength(1);
    expect(parents(s.db)[0]).toMatchObject({ status: "ok", coverage: "unknown" });
  });

  test("an early return after a usage chunk keeps that partial usage", async () => {
    const s = setup();
    const leaf = streamLeaf([{ type: "text", content: "a", usage: { input_tokens: 9, output_tokens: 1 } }, { type: "text", content: "b" }]);
    const gen = meterProvider(leaf, s.opts).query(req()) as AsyncGenerator<ProviderChunk>;
    await gen.next();
    await gen.return(undefined);
    expect(parents(s.db)[0]).toMatchObject({ status: "ok", coverage: "partial" });
    expect(details(s.db)[0]).toMatchObject({ input_tokens: 9, output_tokens: 1, cache_read_tokens: null });
  });

  test("an error thrown by the stream settles once as error and is rethrown unchanged", async () => {
    const s = setup();
    const boom = new Error("stream died");
    const leaf: Provider = { name: "claude", query: () => (async function* () { yield { type: "text", content: "a" } as ProviderChunk; throw boom; })() };
    const gen = meterProvider(leaf, s.opts).query(req()) as AsyncGenerator<ProviderChunk>;
    await gen.next();
    await expect(gen.next()).rejects.toBe(boom);
    expect(parents(s.db)).toHaveLength(1);
    expect(parents(s.db)[0]).toMatchObject({ status: "error" });
  });

  test("throw() into a started stream settles once as error", async () => {
    const s = setup();
    const gen = meterProvider(streamLeaf([{ type: "text", content: "a" }, { type: "text", content: "b" }]), s.opts).query(req()) as AsyncGenerator<ProviderChunk>;
    await gen.next();
    const boom = new Error("consumer failed");
    await expect(gen.throw(boom)).rejects.toBe(boom);
    expect(parents(s.db)).toHaveLength(1);
    expect(parents(s.db)[0]).toMatchObject({ status: "error" });
  });

  test("a stream with two tool rounds is two calls", async () => {
    const s = setup();
    const m = meterProvider(streamLeaf([{ type: "text", content: "x", usage: { input_tokens: 1, output_tokens: 1 } }]), s.opts);
    await drain(m.query(req()) as AsyncGenerator<ProviderChunk>);
    await drain(m.query(req()) as AsyncGenerator<ProviderChunk>);
    expect(parents(s.db)).toHaveLength(2);
    expect(details(s.db)).toHaveLength(2);
  });
});

describe("meterProvider: abort", () => {
  test("an abort settles as aborted at once, and the provider finishing later updates the same call", async () => {
    const s = setup();
    const controller = new AbortController();
    let release!: (r: ProviderResponse) => void;
    const leaf = promiseLeaf(() => new Promise<ProviderResponse>((resolve) => { release = resolve; }));
    const pending = meterProvider(leaf, s.opts).query(req({ signal: controller.signal })) as Promise<ProviderResponse>;
    s.tick(40);
    controller.abort();
    expect(parents(s.db)).toHaveLength(1);
    expect(parents(s.db)[0]).toMatchObject({ status: "aborted", coverage: "unknown", latency_ms: 40 });
    release(response({ input_tokens: 7, output_tokens: 8 }));
    await pending;
    expect(parents(s.db)).toHaveLength(1);
    expect(parents(s.db)[0]).toMatchObject({ status: "aborted", latency_ms: 40 });
    expect(details(s.db)).toHaveLength(1);
    expect(details(s.db)[0]).toMatchObject({ input_tokens: 7, output_tokens: 8 });
  });

  test("a signal that is already aborted when the call starts is recorded once", async () => {
    const s = setup();
    const controller = new AbortController();
    controller.abort();
    const leaf = promiseLeaf(async () => { throw new Error("aborted"); });
    await expect(meterProvider(leaf, s.opts).query(req({ signal: controller.signal })) as Promise<unknown>).rejects.toThrow("aborted");
    expect(parents(s.db)).toHaveLength(1);
    expect(parents(s.db)[0].status).toBe("aborted");
  });
});

describe("meterProvider: wrapper contract", () => {
  test("wrapping a metered provider returns the same object and one query writes one parent", async () => {
    const s = setup();
    const once = meterProvider(promiseLeaf(async () => response({ input_tokens: 1, output_tokens: 1 })), s.opts);
    const twice = meterProvider(once, s.opts);
    expect(twice).toBe(once);
    expect(isMetered(once)).toBe(true);
    await twice.query(req());
    expect(parents(s.db)).toHaveLength(1);
  });

  test("name, sharedSafe and the leaf's prototype are preserved", () => {
    class Leaf implements Provider { readonly name = "leafy"; readonly sharedSafe = true; query() { return Promise.resolve(response()); } extra() { return "kept"; } }
    const metered = meterProvider(new Leaf(), setup().opts) as Leaf;
    expect(metered.name).toBe("leafy");
    expect(metered.sharedSafe).toBe(true);
    expect(metered instanceof Leaf).toBe(true);
    expect(metered.extra()).toBe("kept");
    expect(isMetered(new Leaf())).toBe(false);
  });

  test("a ledger that throws leaves the response unchanged and reports once", async () => {
    const s = setup();
    const broken = { recordCall: () => { throw new Error("disk full"); } };
    const out = await meterProvider(promiseLeaf(async () => response({ input_tokens: 1, output_tokens: 1 })), { ...s.opts, ledger: broken }).query(req()) as ProviderResponse;
    expect(out.message.content).toBe("ok");
    expect(s.errors).toHaveLength(1);
  });

  test("a ledger that throws does not hide the provider's own error", async () => {
    const s = setup();
    const broken = { recordCall: () => { throw new Error("disk full"); } };
    const boom = new Error("upstream");
    await expect(meterProvider(promiseLeaf(async () => { throw boom; }), { ...s.opts, ledger: broken }).query(req()) as Promise<unknown>).rejects.toBe(boom);
  });

  test("constructing the wrapper does not touch the ledger", () => {
    let touched = false;
    const lazy = { recordCall: () => { touched = true; } };
    meterProvider(promiseLeaf(async () => response()), { ledger: lazy });
    expect(touched).toBe(false);
  });
});
