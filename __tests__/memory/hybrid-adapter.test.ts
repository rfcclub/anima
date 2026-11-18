import { test, expect, describe } from "bun:test";
import type { MemoryAdapter, MemoryEntry } from "../../src/memory/adapter";
import { HybridMemoryAdapter, withHindsight } from "../../src/memory/hybrid-adapter";

const e = (content: string, ns = "cleo"): MemoryEntry => ({ namespace: ns, content, type: "fact", timestamp: "2026-10-27T00:00:00Z" });

function stub(rows: MemoryEntry[] | Error): MemoryAdapter & { stored: MemoryEntry[] } {
  const stored: MemoryEntry[] = [];
  return {
    stored,
    async store(x) { stored.push(x); },
    async recall() { if (rows instanceof Error) throw rows; return rows; },
  };
}

describe("HybridMemoryAdapter", () => {
  test("base rows first (cut to topK), then up to extraSlots extra rows, deduplicated", async () => {
    const h = new HybridMemoryAdapter(stub([e("alpha"), e("Beta")]), stub([e("beta "), e("gamma"), e("delta")]), { extraSlots: 2 });
    const rows = await h.recall("q", { topK: 4 });
    expect(rows.map((r) => r.content)).toEqual(["alpha", "Beta", "gamma", "delta"]);
  });

  test("extra rows still appear when the base already fills topK", async () => {
    const full = [e("a"), e("b"), e("c"), e("d"), e("e")];
    const merges: Array<{ baseRows: number; extraRows: number; keptExtra: number }> = [];
    const h = new HybridMemoryAdapter(stub(full), stub([e("hindsight fact"), e("second"), e("third")]), {
      extraSlots: 2,
      onMerge: (m) => merges.push(m),
    });
    const rows = await h.recall("q", { topK: 5 });
    expect(rows.map((r) => r.content)).toEqual(["a", "b", "c", "d", "e", "hindsight fact", "second"]);
    expect(merges).toEqual([{ baseRows: 5, extraRows: 3, keptExtra: 2 }]);
  });

  test("the extra leg is asked for extraSlots rows, not topK", async () => {
    let seen: number | undefined;
    const extra: MemoryAdapter = { async store() {}, async recall(_q, o) { seen = o?.topK; return []; } };
    await new HybridMemoryAdapter(stub([]), extra, { extraSlots: 3 }).recall("q", { topK: 8 });
    expect(seen).toBe(3);
  });

  test("an extra leg that throws leaves the base rows", async () => {
    const h = new HybridMemoryAdapter(stub([e("alpha")]), stub(new Error("hindsight down")));
    expect((await h.recall("q")).map((r) => r.content)).toEqual(["alpha"]);
  });

  test("a base leg that throws propagates the same error", async () => {
    const boom = new Error("sqlite boom");
    const h = new HybridMemoryAdapter(stub(boom), stub([e("gamma")]));
    await expect(h.recall("q")).rejects.toBe(boom);
  });

  test("store goes to the base only", async () => {
    const base = stub([]);
    const extra = stub([]);
    await new HybridMemoryAdapter(base, extra).store(e("kept"));
    expect(base.stored.length).toBe(1);
    expect(extra.stored.length).toBe(0);
  });
});

describe("withHindsight", () => {
  test("without hindsightBank it returns the very same adapter object", () => {
    const base = stub([]);
    expect(withHindsight(base, undefined, "cleo", () => {})).toBe(base);
    expect(withHindsight(base, { type: "shared" }, "cleo", () => {})).toBe(base);
  });

  test("with hindsightBank it wraps the adapter", () => {
    const base = stub([]);
    const wrapped = withHindsight(base, { type: "shared", hindsightBank: "anima-cleo-pilot" }, "cleo", () => {});
    expect(wrapped).not.toBe(base);
    expect(wrapped).toBeInstanceOf(HybridMemoryAdapter);
  });
});
