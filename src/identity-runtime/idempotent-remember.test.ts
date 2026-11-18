import { expect, test } from "bun:test";
import { idempotentRemember, idempotencyTag } from "./idempotent-remember";
import type { AgentMemoryEntry } from "../memory/contract";

function entry(overrides: Partial<AgentMemoryEntry> = {}): Omit<AgentMemoryEntry, "id" | "createdAt"> {
  return {
    content: "hello",
    scope: "observation",
    tags: [],
    confidence: 0.8,
    source: "test",
    ...overrides,
  };
}

test("writes once, tagging the entry with the idempotency key", async () => {
  const written: Array<Omit<AgentMemoryEntry, "id" | "createdAt">> = [];
  const store = {
    remember: async (e: Omit<AgentMemoryEntry, "id" | "createdAt">) => {
      written.push(e);
      return { ...e, id: "new-id", createdAt: "2026-09-27T00:00:00Z" } as AgentMemoryEntry;
    },
    findByTag: async () => undefined,
  };

  const remember = idempotentRemember(store);
  const result = await remember({ grantId: "g", stateHash: "s", idempotencyKey: "k1", entry: entry() });

  expect(result).toEqual({ id: "new-id", createdAt: "2026-09-27T00:00:00Z" });
  expect(written).toEqual([entry({ tags: [idempotencyTag("k1")] })]);
});

test("returns the existing entry instead of writing again when the tag is already present", async () => {
  let writeCalls = 0;
  const store = {
    remember: async () => {
      writeCalls += 1;
      throw new Error("should not be called");
    },
    findByTag: async (tag: string) =>
      tag === idempotencyTag("k1")
        ? ({ id: "old-id", content: "hello", scope: "observation", tags: [tag], confidence: 0.8, source: "test", createdAt: "2026-09-26T00:00:00Z" } as AgentMemoryEntry)
        : undefined,
  };

  const remember = idempotentRemember(store);
  const result = await remember({ grantId: "g", stateHash: "s", idempotencyKey: "k1", entry: entry() });

  expect(result).toEqual({ id: "old-id", createdAt: "2026-09-26T00:00:00Z" });
  expect(writeCalls).toBe(0);
});

test("always writes when the store cannot dedupe (no findByTag)", async () => {
  const written: string[] = [];
  const store = {
    remember: async (e: Omit<AgentMemoryEntry, "id" | "createdAt">) => {
      written.push(e.content);
      return { ...e, id: "id-" + written.length, createdAt: "now" } as AgentMemoryEntry;
    },
  };

  const remember = idempotentRemember(store);
  await remember({ grantId: "g", stateHash: "s", idempotencyKey: "k1", entry: entry() });
  await remember({ grantId: "g", stateHash: "s", idempotencyKey: "k1", entry: entry() });

  expect(written).toEqual(["hello", "hello"]);
});
