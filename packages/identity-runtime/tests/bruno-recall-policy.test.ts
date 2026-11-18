import { expect, test } from "bun:test";
import {
  createDirectRecallPolicy,
  JevQueryClassifier,
  recall,
  type QueryClassifier,
  type RecallDeps,
  type RecallResult,
  type RecallSource,
} from "../src/bruno-recall-policy.ts";
import type { AgentMemoryEntry } from "../../../src/memory/contract.ts";

class EmptyClassifier implements QueryClassifier {
  async classify(): Promise<RecallSource[]> {
    return [];
  }
}

test("Bruno direct recall policy keeps a no-match query side-effect free", async () => {
  await expect(recall("unrelated query", { classifier: new EmptyClassifier() })).resolves.toEqual([]);
});

// Windows (and any HTTP-only host) has no local bruno-entity to fall back to, so the
// runtime's direct recall must itself ask bruno_entity even for repo/engineering
// queries that the classifier sends nowhere (identity-runtime-federated-recall).
class FixedClassifier implements QueryClassifier {
  constructor(private readonly sources: RecallSource[]) {}
  async classify(): Promise<RecallSource[]> {
    return this.sources;
  }
}

function fakeDispatchers(calls: RecallSource[]): NonNullable<RecallDeps["dispatchers"]> {
  const make = (source: RecallSource) => async (): Promise<RecallResult> => {
    calls.push(source);
    return { source, content: `${source} hit` };
  };
  return { hive: make("hive"), bruno_entity: make("bruno_entity") };
}

test("recall() still asks nothing when the classifier picks nothing (bruno-runtime contract)", async () => {
  const calls: RecallSource[] = [];
  await recall("q", { classifier: new EmptyClassifier(), dispatchers: fakeDispatchers(calls) });
  expect(calls).toEqual([]);
});

test("direct policy asks bruno_entity even when the classifier picks nothing", async () => {
  const calls: RecallSource[] = [];
  const policy = createDirectRecallPolicy({ classifier: new EmptyClassifier(), dispatchers: fakeDispatchers(calls) });
  await expect(policy.recall("chamber encounter guard")).resolves.toEqual([{ source: "bruno_entity", content: "bruno_entity hit" }]);
  expect(calls).toEqual(["bruno_entity"]);
});

test("direct policy asks bruno_entity once when the classifier already picked it, and keeps hive", async () => {
  const calls: RecallSource[] = [];
  const policy = createDirectRecallPolicy({ classifier: new FixedClassifier(["hive", "bruno_entity"]), dispatchers: fakeDispatchers(calls) });
  const results = await policy.recall("lena and bruno");
  expect(calls).toEqual(["hive", "bruno_entity"]);
  expect(results.map((r) => r.source)).toEqual(["hive", "bruno_entity"]);
});

test("direct policy never surfaces the unimplemented rag source as memory", async () => {
  const calls: RecallSource[] = [];
  const policy = createDirectRecallPolicy({ classifier: new FixedClassifier(["rag"]), dispatchers: fakeDispatchers(calls) });
  const results = await policy.recall("search the wiki for X");
  expect(results.map((r) => r.source)).toEqual(["bruno_entity"]);
  expect(JSON.stringify(results)).not.toContain("not yet implemented");
});

// Relevance floor: bruno_entity's own recall is "loose" (every
// neuron in one response used to share a single whole-response confidence
// label), so a barely-relevant match rode along with strong ones. dispatchBrunoEntity
// now applies a local, non-network relevance cut before joining content.
function entry(overrides: Partial<AgentMemoryEntry>): AgentMemoryEntry {
  return {
    id: overrides.id ?? "id",
    content: overrides.content ?? "content",
    scope: "observation",
    tags: [],
    confidence: overrides.confidence ?? 1,
    source: "bruno",
    createdAt: "now",
    ...overrides,
  };
}

test("dispatchBrunoEntity asks the store for a minConfidence floor", async () => {
  const seen: Array<{ query: string; options: unknown }> = [];
  const policy = createDirectRecallPolicy({
    classifier: new EmptyClassifier(),
    brunoEntityAdapter: {
      recall: async (query, options) => {
        seen.push({ query, options });
        return [entry({ id: "strong", content: "relevant", confidence: 0.9 })];
      },
    },
  });

  await policy.recall("chamber encounter guard");

  expect(seen).toHaveLength(1);
  expect(seen[0].query).toBe("chamber encounter guard");
  expect((seen[0].options as { minConfidence: number }).minConfidence).toBeGreaterThan(0);
  expect((seen[0].options as { minConfidence: number }).minConfidence).toBeLessThan(0.5);
});

test("dispatchBrunoEntity's content only reflects what the store already filtered", async () => {
  const policy = createDirectRecallPolicy({
    classifier: new EmptyClassifier(),
    brunoEntityAdapter: {
      recall: async () => [entry({ content: "kept" })], // the store, not the dispatcher, applies the cut
    },
  });

  const results = await policy.recall("chamber encounter guard");

  expect(results).toEqual([{ source: "bruno_entity", content: "kept" }]);
});

// The "never send runtime memory to the external relevance filter" rule
// holds structurally: JevQueryClassifier.decide only ever receives the
// query string, never a memory entry or recall result.
test("the Jev classifier is given only the query text, never memory content", async () => {
  const seen: string[] = [];
  const classifier = new JevQueryClassifier(async (state) => {
    seen.push(state);
    return null;
  });

  await classifier.classify("what did you just remember?");

  expect(seen).toEqual(["what did you just remember?"]);
});
