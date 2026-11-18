import { test, expect } from "bun:test";
import type { AgentMemoryEntry, AgentMemoryStore } from "../../src/memory/contract";
import {
  ScopedMemoryStore,
  MemoryScopeViolationError,
  guardMemoryStore,
} from "../../src/memory/scoped-store";

function fakeStore() {
  const written: AgentMemoryEntry[] = [];
  const store: AgentMemoryStore = {
    async remember(entry) {
      const full: AgentMemoryEntry = { ...entry, id: `id-${written.length}`, createdAt: new Date().toISOString() };
      written.push(full);
      return full;
    },
    async recall() { return []; },
    async bootstrap() { return []; },
    async forget() {},
  };
  return { store, written };
}

const base = { content: "m", tags: [], confidence: 0.8, source: "test" };

test("SC-040 identity write rejected under cartridge", async () => {
  const { store, written } = fakeStore();
  const guarded = new ScopedMemoryStore(store, { cartridge: "programming" });
  await expect(guarded.remember({ ...base, scope: "identity" })).rejects.toThrow(MemoryScopeViolationError);
  expect(written.length).toBe(0);
});

test("SC-041b locked scope stays locked even when declared by the cartridge", async () => {
  const { store, written } = fakeStore();
  const guarded = new ScopedMemoryStore(store, { cartridge: "evil", writeScopes: ["identity", "scar"] });
  await expect(guarded.remember({ ...base, scope: "identity" })).rejects.toThrow(MemoryScopeViolationError);
  expect(written.length).toBe(0);
  const ok = await guarded.remember({ ...base, scope: "scar" });
  expect(ok.scope).toBe("scar");
});

test("SC-042 declared scope allowed with provenance", async () => {
  const { store, written } = fakeStore();
  const guarded = new ScopedMemoryStore(store, { cartridge: "programming", writeScopes: ["scar", "decision"] });
  await guarded.remember({ ...base, scope: "scar" });
  expect(written.length).toBe(1);
});

test("SC-043 undeclared scope rejected", async () => {
  const { store } = fakeStore();
  const guarded = new ScopedMemoryStore(store, { cartridge: "programming", writeScopes: ["scar", "decision"] });
  await expect(guarded.remember({ ...base, scope: "preference" })).rejects.toThrow(MemoryScopeViolationError);
});

test("SC-044 no cartridge means no wrapper", () => {
  const { store } = fakeStore();
  expect(guardMemoryStore(store, undefined)).toBe(store);
  expect(guardMemoryStore(undefined, undefined)).toBeUndefined();
});

test("SC-045 provenance tagged in metadata", async () => {
  const { store, written } = fakeStore();
  const guarded = new ScopedMemoryStore(store, { cartridge: "programming" });
  await guarded.remember({ ...base, scope: "scar", metadata: { foo: 1 } });
  expect(written[0].metadata).toEqual({ foo: 1, cartridge: "programming" });
});

test("SC-046 violations audited", async () => {
  const { store } = fakeStore();
  const guarded = new ScopedMemoryStore(store, { cartridge: "programming" });
  await expect(guarded.remember({ ...base, scope: "identity" })).rejects.toThrow();
  await expect(guarded.remember({ ...base, scope: "private" })).rejects.toThrow();
  const v = guarded.violations();
  expect(v.length).toBe(2);
  expect(v[0]).toMatchObject({ cartridge: "programming", scope: "identity" });
  expect(v[1]).toMatchObject({ cartridge: "programming", scope: "private" });
});

test("SC-047 pipeline eval input accepts scope violations", async () => {
  const { EvaluationPipeline } = await import("../../src/evaluation/pipeline");
  const input = {
    agentId: "testa",
    output: "did some work",
    domain: "memory" as const,
    scopeViolations: [{ cartridge: "programming", scope: "identity", timestamp: new Date().toISOString() }],
  };
  // Type-level seam check: the field must be an accepted part of EvalInput.
  const accepted: Parameters<InstanceType<typeof EvaluationPipeline>["evaluate"]>[0] = input;
  expect(accepted.scopeViolations?.length).toBe(1);
});
