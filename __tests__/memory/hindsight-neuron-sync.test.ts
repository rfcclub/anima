import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entityPairs, syncHindsightBank, HindsightSyncError, type SyncSink } from "../../src/memory/hindsight-neuron-sync";

const TOKEN = "SECRET-TOKEN-VALUE";

function item(id: string, text: string, entities: string | string[] = "") {
  return { id, text, entities, fact_type: "experience", mentioned_at: "2026-10-27T12:00:00+00:00" };
}

function fakeFetch(items: unknown[], status = 200, pageCap = Infinity) {
  const calls: string[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    expect((init?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${TOKEN}`);
    if (status !== 200) return new Response("boom", { status });
    const u = new URL(String(url));
    const off = Number(u.searchParams.get("offset") ?? 0);
    const lim = Math.min(Number(u.searchParams.get("limit") ?? 100), pageCap);
    return new Response(JSON.stringify({ items: items.slice(off, off + lim), total: items.length }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function memSink(initial: Record<string, string> = {}) {
  const neurons: Array<{ id: string; source: string; content: string; type: string; scope: string; tags: string[]; metadata: Record<string, unknown> }> = [];
  const synapses: Array<{ a: string; b: string; type: string; weight: number; metadata: Record<string, unknown> }> = [];
  const existing = new Map(Object.entries(initial));
  const log: string[] = [];
  let depth = 0;
  const sink: SyncSink = {
    transaction: (fn) => {
      log.push("tx:begin");
      depth++;
      try { return fn(); } finally { depth--; log.push("tx:end"); }
    },
    flush: async () => { log.push("flush"); },
    existing: () => new Map(existing),
    addNeuron: (n) => {
      log.push(depth > 0 ? "neuron:in-tx" : "neuron:out-of-tx");
      const id = `n${neurons.length + 1}`;
      neurons.push({ id, source: n.source, content: n.content, type: n.type, scope: n.scope, tags: n.tags, metadata: n.metadata });
      existing.set(n.source.replace(/^hindsight:/, ""), id);
      return id;
    },
    addSynapse: (a, b, type, weight, metadata) => {
      log.push(depth > 0 ? "synapse:in-tx" : "synapse:out-of-tx");
      synapses.push({ a, b, type, weight, metadata });
    },
  };
  return { sink, neurons, synapses, log };
}

const base = { bank: "b", agent: "cleo", apiUrl: "http://h", apiToken: TOKEN };

describe("entityPairs", () => {
  test("links neurons that share an entity, once per pair", () => {
    const pairs = entityPairs([
      { key: "1", entities: ["Foo", "Bar"] },
      { key: "2", entities: ["foo", "bar"] },
      { key: "3", entities: ["Baz"] },
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.a).toBe("1");
    expect(pairs[0]!.b).toBe("2");
    expect(pairs[0]!.entity).toBe("bar");
  });

  test("ignores generic entities and groups larger than 12", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, entities: ["common", "user"] }));
    expect(entityPairs(many)).toEqual([]);
    const twelve = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, entities: ["common"] }));
    expect(entityPairs(twelve)).toHaveLength(66);
  });
});

describe("syncHindsightBank", () => {
  test("creates neurons with the ivan shape, then is idempotent", async () => {
    const items = [item("h1", "alpha fact", "Foo, Bar"), item("h2", "beta fact", "foo")];
    const { fn, calls } = fakeFetch(items);
    const s = memSink();
    const r1 = await syncHindsightBank({ ...base, fetchFn: fn, sink: s.sink, apply: true });
    expect(r1).toMatchObject({ scanned: 2, created: 2, skipped: 0, synapses: 1, applied: true });
    expect(calls[0]).toContain("/v1/default/banks/b/memories/list");
    expect(calls[0]).toContain("type=experience");
    const n = s.neurons[0]!;
    expect(n.type).toBe("hindsight-sync");
    expect(n.scope).toBe("cleo");
    expect(n.source).toBe("hindsight:h1");
    expect(n.tags).toEqual(["hindsight", "experience", "episodic", "migrated"]);
    expect(n.metadata).toMatchObject({ hindsight_id: "h1", entities: "Foo, Bar", fact_type: "experience", occurred_at: "2026-10-27T12:00:00+00:00" });
    expect(s.synapses[0]).toMatchObject({ type: "co_entity", weight: 0.5, metadata: { entity: "foo" } });

    const r2 = await syncHindsightBank({ ...base, fetchFn: fn, sink: s.sink, apply: true });
    expect(r2).toMatchObject({ created: 0, synapses: 0 });
    expect(s.neurons).toHaveLength(2);
    expect(s.synapses).toHaveLength(1);
  });

  test("a rerun links a new neuron to old ones but not old to old", async () => {
    const items = [item("h1", "a", "Foo"), item("h2", "b", "Foo")];
    const s = memSink();
    await syncHindsightBank({ ...base, fetchFn: fakeFetch(items).fn, sink: s.sink, apply: true });
    expect(s.synapses).toHaveLength(1);
    items.push(item("h3", "c", "Foo"));
    const r = await syncHindsightBank({ ...base, fetchFn: fakeFetch(items).fn, sink: s.sink, apply: true });
    expect(r.created).toBe(1);
    expect(r.synapses).toBe(2);
    expect(s.synapses).toHaveLength(3);
  });

  test("pages through the bank and skips empty text", async () => {
    const items = Array.from({ length: 150 }, (_, i) => item(`h${i}`, i === 7 ? "  " : `fact ${i}`));
    const s = memSink();
    const r = await syncHindsightBank({ ...base, fetchFn: fakeFetch(items).fn, sink: s.sink, apply: true });
    expect(r).toMatchObject({ scanned: 150, created: 149, skipped: 1 });
  });

  test("dry run writes nothing but reports counts", async () => {
    const items = [item("h1", "a", "Foo"), item("h2", "b", "Foo")];
    const s = memSink();
    const r = await syncHindsightBank({ ...base, fetchFn: fakeFetch(items).fn, sink: s.sink, apply: false });
    expect(r).toMatchObject({ created: 2, synapses: 1, applied: false });
    expect(s.neurons).toHaveLength(0);
    expect(s.synapses).toHaveLength(0);
  });

  test("writes happen inside one sink transaction, then embeddings are flushed", async () => {
    const items = [item("h1", "a", "Foo"), item("h2", "b", "Foo")];
    const s = memSink();
    await syncHindsightBank({ ...base, fetchFn: fakeFetch(items).fn, sink: s.sink, apply: true });
    expect(s.log).toEqual(["tx:begin", "neuron:in-tx", "neuron:in-tx", "synapse:in-tx", "tx:end", "flush"]);
  });

  test("dry run opens no transaction and flushes nothing", async () => {
    const s = memSink();
    await syncHindsightBank({ ...base, fetchFn: fakeFetch([item("h1", "a", "Foo")]).fn, sink: s.sink, apply: false });
    expect(s.log).toEqual([]);
  });

  test("a write failure inside the transaction propagates and skips the flush", async () => {
    const s = memSink();
    const boom: SyncSink = { ...s.sink, addSynapse: () => { throw new Error("disk full"); } };
    const items = [item("h1", "a", "Foo"), item("h2", "b", "Foo")];
    await expect(syncHindsightBank({ ...base, fetchFn: fakeFetch(items).fn, sink: boom, apply: true })).rejects.toThrow("disk full");
    expect(s.log).not.toContain("flush");
    expect(s.log.at(-1)).toBe("tx:end");
  });

  test("keeps paging when the server caps the page below 100", async () => {
    const items = Array.from({ length: 150 }, (_, i) => item(`h${i}`, `fact ${i}`));
    const s = memSink();
    const r = await syncHindsightBank({ ...base, fetchFn: fakeFetch(items, 200, 50).fn, sink: s.sink, apply: true });
    expect(r).toMatchObject({ scanned: 150, created: 150 });
  });

  test("a numeric Hindsight id is synced, not silently skipped", async () => {
    const s = memSink();
    const r = await syncHindsightBank({ ...base, fetchFn: fakeFetch([{ ...item("x", "numeric"), id: 42 }]).fn, sink: s.sink, apply: true });
    expect(r).toMatchObject({ created: 1, skipped: 0 });
    expect(s.neurons[0]!.source).toBe("hindsight:42");
  });

  test("Hindsight failure throws HindsightSyncError without the token and writes nothing", async () => {
    const s = memSink();
    let err: unknown;
    try {
      await syncHindsightBank({ ...base, fetchFn: fakeFetch([], 503).fn, sink: s.sink, apply: true });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HindsightSyncError);
    expect(String((err as Error).message)).toContain("503");
    expect(String((err as Error).message)).not.toContain(TOKEN);
    expect(s.neurons).toHaveLength(0);
  });
});

describe("AnimaEntityStore sync helpers", () => {
  test("addNeuronRecord keeps type/scope/source and sourceIndex finds it", async () => {
    const { AnimaEntityStore } = await import("../../src/memory/anima-entity-store");
    const store = new AnimaEntityStore(join(tmpdir(), `hns-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
    await store.initialize();
    const id = store.addNeuronRecord({
      type: "hindsight-sync", scope: "cleo", content: "x", tags: ["hindsight"], source: "hindsight:h9", confidence: 0.95,
      metadata: { hindsight_id: "h9" },
    });
    expect(store.sourceIndex("hindsight:").get("hindsight:h9")).toBe(id);
    const n = store.getNeuron(id);
    expect(n?.type).toBe("hindsight-sync");
    store.close();
  });

  async function openStore() {
    const { AnimaEntityStore } = await import("../../src/memory/anima-entity-store");
    const store = new AnimaEntityStore(join(tmpdir(), `hns-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
    await store.initialize();
    return store;
  }
  const embeddingRows = (store: unknown) =>
    ((store as { db: { prepare(sql: string): { get(): { c: number } } } }).db.prepare("SELECT COUNT(*) AS c FROM embeddings").get()).c;

  test("flushEmbeddings waits for in-flight embeddings so close() cannot drop them", async () => {
    const store = await openStore();
    const raw = store as unknown as { embeddingsAvailable: boolean; generateEmbedding: (t: string) => Promise<number[]> };
    raw.embeddingsAvailable = true;
    raw.generateEmbedding = async () => { await new Promise((r) => setTimeout(r, 50)); return [0.1, 0.2, 0.3]; };
    for (const h of ["h1", "h2"]) {
      store.addNeuronRecord({ type: "hindsight-sync", scope: "cleo", content: h, tags: [], source: `hindsight:${h}`, confidence: 0.95, metadata: {} });
    }
    expect(embeddingRows(store)).toBe(0);
    await store.flushEmbeddings();
    expect(embeddingRows(store)).toBe(2);
    store.close();
  });

  test("transaction rolls back neurons and synapses when the callback throws", async () => {
    const store = await openStore();
    const rec = (h: string) => ({ type: "hindsight-sync", scope: "cleo", content: h, tags: [], source: `hindsight:${h}`, confidence: 0.95, metadata: {} });
    expect(() =>
      store.transaction(() => {
        const a = store.addNeuronRecord(rec("h1"));
        const b = store.addNeuronRecord(rec("h2"));
        store.addSynapse(a, b, "co_entity", 0.5, {});
        throw new Error("crash");
      }),
    ).toThrow("crash");
    expect(store.sourceIndex("hindsight:").size).toBe(0);
    store.close();
  });
});
