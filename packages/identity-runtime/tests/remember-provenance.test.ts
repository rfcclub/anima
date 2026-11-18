import { expect, test } from "bun:test";
import { tagProvenance } from "../src/remember-provenance.ts";
import type { AgentMemoryEntry } from "../../../src/memory/contract.ts";

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

test("adds source-client and source-surface tags without dropping existing tags", () => {
  const tagged = tagProvenance(entry({ tags: ["existing"] }), { clientId: "windows-codex", surfaceId: "host-pc" });

  expect(tagged.tags).toEqual(["existing", "source-client:windows-codex", "source-surface:host-pc"]);
});

test("records sourceClientId and sourceSurfaceId in metadata without dropping existing metadata", () => {
  const tagged = tagProvenance(entry({ metadata: { other: 1 } }), { clientId: "bruno-cli", surfaceId: "claude" });

  expect(tagged.metadata).toEqual({ other: 1, sourceClientId: "bruno-cli", sourceSurfaceId: "claude" });
});

test("leaves content/scope/confidence untouched", () => {
  const original = entry({ content: "specific content", confidence: 0.42 });

  const tagged = tagProvenance(original, { clientId: "c", surfaceId: "s" });

  expect(tagged.content).toBe("specific content");
  expect(tagged.confidence).toBe(0.42);
  expect(tagged.scope).toBe(original.scope);
});
