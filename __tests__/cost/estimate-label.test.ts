/**
 * cost-ledger-accuracy, CL-9: the dashboard says when the estimate is
 * not a complete, verified charge, and shows the pre-call-record history apart.
 */

import { test, expect } from "bun:test";
import { describeEstimate, describeLegacy } from "../../src/ui/features/cost/lib/estimate";

test("a complete estimate has no warning", () => {
  expect(describeEstimate({ estimateComplete: true, unknownCalls: 0, partialCalls: 0, fallbackPriced: [] })).toBeNull();
});

test("an old API answer without the new fields is not called incomplete", () => {
  expect(describeEstimate({})).toBeNull();
});

test("an incomplete estimate lists unknown, partial and guessed-price counts", () => {
  expect(describeEstimate({
    estimateComplete: false,
    unknownCalls: 3,
    partialCalls: 2,
    fallbackPriced: [{ provider: "claude", model: "mystery", calls: 4 }, { provider: "x", model: "y", calls: 1 }],
  })).toBe("Estimate incomplete: 3 calls without usage, 2 with partial usage, 5 priced at a default");
});

test("only the non-zero causes are listed", () => {
  expect(describeEstimate({ estimateComplete: false, unknownCalls: 1, partialCalls: 0, fallbackPriced: [] })).toBe("Estimate incomplete: 1 call without usage");
});

test("the legacy line shows requests and cost, or nothing when there are none", () => {
  expect(describeLegacy({ summary: { totalRequests: 3330, estimatedCost: 12.5 } })).toBe("Before call records: 3,330 requests, $12.5000 (as stored)");
  expect(describeLegacy({ summary: { totalRequests: 0, estimatedCost: 0 } })).toBeNull();
  expect(describeLegacy(undefined)).toBeNull();
});
