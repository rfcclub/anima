import { afterAll, beforeAll, expect, test } from "bun:test";
import { executeTool } from "../../src/tools/executor";
import { buildToolDefinitions } from "../../src/tools/definitions";
import { AnimaEntityStore } from "../../src/memory/anima-entity-store";
import type { AgentMemoryStore } from "../../src/memory/contract";

const store = new AnimaEntityStore(":memory:");
beforeAll(async () => {
  await store.initialize();
  // Import fixture rows directly: no remember/addNeuron embedding requests.
  store.importAll([
    { id: "old-fact", type: "fact", content: "older fixture", created_at: "2026-01-01T00:00:00Z" },
    { id: "insight", type: "insight", content: "other scope", created_at: "2026-01-02T00:00:00Z" },
    { id: "new-fact", type: "fact", content: "newer fixture", created_at: "2026-01-03T00:00:00Z" },
  ], [], false);
});
afterAll(() => store.close());

function call(name: string, args = {}, memoryStore: AgentMemoryStore | undefined = store as unknown as AgentMemoryStore) {
  return executeTool({ id: "fixture", name, arguments: JSON.stringify(args) }, { policy: null, memoryStore });
}

test("D2 regression: legacy list alias returns the canonical envelope, scope and page", async () => {
  for (const args of [{}, { scope: "fact", limit: 1, offset: 1 }, { scope: "missing" }]) {
    const canonical = JSON.parse(await call("anima_memory_list", args));
    const alias = JSON.parse(await call("anima_list_all", args));
    expect(alias).toEqual(canonical);
    expect(alias.count).toBe(alias.entries.length);
  }
  const page = JSON.parse(await call("anima_list_all", { scope: "fact", limit: 1, offset: 1 }));
  expect(page.entries.map((entry: any) => entry.id)).toEqual(["old-fact"]);
});

test("D2: both list names refuse a store without listing support", async () => {
  for (const name of ["anima_list_all", "anima_memory_list"]) {
    expect(JSON.parse(await call(name, {}, {} as AgentMemoryStore)))
      .toEqual({ status: "error", message: "list not supported" });
  }
});

test("D3 regression: model definitions omit unimplemented tools but keep supported tools", () => {
  expect(buildToolDefinitions(["anima_sleep", "anima_context_expand", "anima_memory_list", "anima_context_search"])
    .map((tool) => tool.name)).toEqual(["anima_memory_list", "anima_context_search"]);
});

test("D3 regression: runtime discovery omits unimplemented tools", async () => {
  const discovered = JSON.parse(await call("anima_tool_list"));
  expect(discovered.tools).not.toContain("anima_sleep");
  expect(discovered.tools).not.toContain("anima_context_expand");
  expect(discovered.tools).toContain("anima_memory_list");
  expect(discovered.tools).toContain("anima_context_search");
  expect(discovered.count).toBe(discovered.tools.length);
});

test("D3 regression: legacy stub calls explicitly fail with or without session stores", async () => {
  for (const name of ["anima_sleep", "anima_context_expand"]) {
    for (const available of [store, undefined]) {
      const result = JSON.parse(await executeTool({ id: "old-prompt", name, arguments: "{}" }, {
        policy: null, memoryStore: available as unknown as AgentMemoryStore,
      }));
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/not implemented|not available/);
    }
  }
});
