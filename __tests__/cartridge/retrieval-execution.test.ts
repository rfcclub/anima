import { describe, test, expect } from "bun:test";
import {
  executeRetrievalPlan,
  mergeAndDedupe,
  splitTrustedUnverified,
} from "../../src/cartridge/retrieval";
import type { SubstrateRetrievalPlan, RetrievedMemory } from "../../src/cartridge/types";

function makeMemory(overrides: Partial<RetrievedMemory> & { id: string }): RetrievedMemory {
  return {
    content: "Some memory",
    scope: "episode",
    confidence: 0.8,
    score: 0.9,
    requested_by: [],
    policy_id: "test",
    trusted: true,
    ...overrides,
  };
}

describe("merge and dedupe", () => {
  test("SC-005: same memory from two cartridges deduplicated", () => {
    const memories: RetrievedMemory[] = [
      makeMemory({ id: "mem-1", requested_by: ["programmer"], policy_id: "programmer" }),
      makeMemory({ id: "mem-1", requested_by: ["typescript"], policy_id: "typescript" }),
    ];

    const merged = mergeAndDedupe(memories);
    expect(merged.length).toBe(1);
    expect(merged[0].requested_by).toContain("programmer");
    expect(merged[0].requested_by).toContain("typescript");
  });

  test("different memories stay separate", () => {
    const memories: RetrievedMemory[] = [
      makeMemory({ id: "mem-1", requested_by: ["programmer"] }),
      makeMemory({ id: "mem-2", requested_by: ["typescript"] }),
    ];

    const merged = mergeAndDedupe(memories);
    expect(merged.length).toBe(2);
  });

  test("SC-006: ranking by confidence", () => {
    const memories: RetrievedMemory[] = [
      makeMemory({ id: "mem-1", confidence: 0.5, score: 0.5 }),
      makeMemory({ id: "mem-2", confidence: 0.9, score: 0.9 }),
    ];

    const merged = mergeAndDedupe(memories);
    expect(merged[0].id).toBe("mem-2"); // higher confidence ranks first
  });
});

describe("trusted vs unverified split", () => {
  test("SC-008: require_evidence filters low confidence", () => {
    const memories: RetrievedMemory[] = [
      makeMemory({ id: "mem-1", confidence: 0.9, trusted: true }),
      makeMemory({ id: "mem-2", confidence: 0.3, trusted: false }),
    ];

    const { trusted, unverified, contextStarved } = splitTrustedUnverified(memories, true, false);
    expect(trusted.length).toBe(1);
    expect(trusted[0].id).toBe("mem-1");
    expect(unverified.length).toBe(0);
    expect(contextStarved).toBe(false);
  });

  test("SC-009: context_starved when no trusted results", () => {
    const memories: RetrievedMemory[] = [
      makeMemory({ id: "mem-1", confidence: 0.3, trusted: false }),
    ];

    const { trusted, unverified, contextStarved } = splitTrustedUnverified(memories, true, false);
    expect(trusted.length).toBe(0);
    expect(contextStarved).toBe(true);
  });

  test("SC-010: unverified fallback when opted in", () => {
    const memories: RetrievedMemory[] = [
      makeMemory({ id: "mem-1", confidence: 0.3, trusted: false }),
    ];

    const { trusted, unverified, contextStarved } = splitTrustedUnverified(memories, true, true);
    expect(trusted.length).toBe(0);
    expect(unverified.length).toBe(1);
    expect(unverified[0].id).toBe("mem-1");
    expect(contextStarved).toBe(false);
  });

  test("no require_evidence — all memories trusted", () => {
    const memories: RetrievedMemory[] = [
      makeMemory({ id: "mem-1", confidence: 0.9 }),
      makeMemory({ id: "mem-2", confidence: 0.3 }),
    ];

    const { trusted, unverified } = splitTrustedUnverified(memories, false, false);
    expect(trusted.length).toBe(2);
    expect(unverified.length).toBe(0);
  });
});

describe("retrieval plan execution", () => {
  test("SC-003: scopes passed to adapter.recall", async () => {
    const plan: SubstrateRetrievalPlan = {
      requests: [
        {
          cartridgeName: "programmer",
          scopes: ["project", "episode"],
          top_k: 8,
          max_tokens: 2000,
          require_evidence: false,
          allow_unverified_fallback: false,
        },
      ],
      globalBudget: 5000,
    };

    const recalled: Array<{ message: string; options: Record<string, unknown> }> = [];
    const mockAdapter = {
      recall: async (message: string, options: Record<string, unknown>) => {
        recalled.push({ message, options });
        return [
          makeMemory({ id: "mem-1", requested_by: ["programmer"], policy_id: "programmer" }),
        ];
      },
    };

    const result = await executeRetrievalPlan(plan, "fix the bug", mockAdapter as any);
    expect(recalled.length).toBe(1);
    expect(recalled[0].options).toHaveProperty("scopes");
    expect(recalled[0].options).toHaveProperty("topK");
  });

  test("SC-004: results tagged with attribution", async () => {
    const plan: SubstrateRetrievalPlan = {
      requests: [
        {
          cartridgeName: "programmer",
          scopes: ["project"],
          top_k: 5,
          max_tokens: 2000,
          require_evidence: false,
          allow_unverified_fallback: false,
        },
      ],
      globalBudget: 5000,
    };

    const mockAdapter = {
      recall: async () => [
        { id: "mem-1", content: "Memory 1", scope: "project", confidence: 0.8, score: 0.9 },
      ],
    };

    const result = await executeRetrievalPlan(plan, "fix the bug", mockAdapter as any);
    expect(result.memories.length).toBe(1);
    expect(result.memories[0].requested_by).toContain("programmer");
  });

  test("SC-011: no retrieval plan = legacy fallback", async () => {
    const mockAdapter = {
      recall: async () => [
        { id: "mem-1", content: "Memory 1", scope: "episode", confidence: 0.8, score: 0.9 },
      ],
    };

    const result = await executeRetrievalPlan(null, "hello", mockAdapter as any, 5);
    expect(result.memories.length).toBe(1);
  });

  test("fix-2: low-confidence memory is NOT trusted regardless of require_evidence", async () => {
    const plan: SubstrateRetrievalPlan = {
      requests: [
        {
          cartridgeName: "test",
          scopes: ["episode"],
          top_k: 5,
          max_tokens: 2000,
          require_evidence: false,
          allow_unverified_fallback: false,
        },
      ],
      globalBudget: 5000,
    };

    const mockAdapter = {
      recall: async () => [
        { id: "mem-1", content: "Low conf", scope: "episode", confidence: 0.1, score: 0.1 },
      ],
    };

    const result = await executeRetrievalPlan(plan, "hello", mockAdapter as any);
    expect(result.memories.length).toBe(1);
    expect(result.memories[0].trusted).toBe(false); // confidence 0.1 < 0.5
  });

  test("fix-3: legacy fallback returns contextStarved when empty", async () => {
    const mockAdapter = {
      recall: async () => [] as Array<{ id: string; content: string; scope: string; confidence: number; score: number }>,
    };

    const result = await executeRetrievalPlan(null, "hello", mockAdapter as any, 5);
    expect(result.memories.length).toBe(0);
    expect(result.contextStarved).toBe(true);
  });
});
