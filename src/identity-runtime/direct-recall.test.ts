import { expect, test } from "bun:test";
import { storeDirectRecall } from "./direct-recall";

test("maps the store's entries to {source, content} and asks for the top few", async () => {
  const asked: Array<{ query: string; options: unknown }> = [];
  const recall = storeDirectRecall({
    recall: async (query, options) => {
      asked.push({ query, options });
      return [{ id: "1", content: "decided X", scope: "decision", tags: [], confidence: 1, source: "t", createdAt: "now" }];
    },
  }, "abel_memory");

  await expect(recall({ query: "what did I decide?" })).resolves.toEqual([{ source: "abel_memory", content: "decided X" }]);
  expect(asked).toEqual([{ query: "what did I decide?", options: { topK: 5 } }]);
});
