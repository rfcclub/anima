/**
 * cost-ledger-accuracy: the report counts calls from parents,
 * prices each known detail once, keeps legacy rows apart and applies exact UTC
 * ranges. In-memory databases only.
 */

import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { TokenLedger, type CallRecord } from "../../src/cost/ledger";
import { CostReporter, parseRange } from "../../src/cost/reporter";
import type { PricingConfig } from "../../src/cost/pricing";

const PRICES: PricingConfig = {
  claude: { "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 }, default: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 } },
  minimax: { default: { input: 0.6, output: 4.0, cacheRead: 0.12 } },
};

function setup(loadPricing: () => PricingConfig = () => PRICES) {
  const db = new Database(":memory:");
  const ledger = new TokenLedger(db);
  return { db, ledger, reporter: new CostReporter(db, { loadPricing }) };
}

let n = 0;
const call = (over: Partial<CallRecord> = {}): CallRecord => ({
  callId: `c${++n}`,
  agentId: "bruno",
  sessionId: "s1",
  backend: "claude",
  startedAt: "2026-10-22T12:00:00.000Z",
  latencyMs: 100,
  status: "ok",
  coverage: "complete",
  details: [{ model: "claude-sonnet-4-6", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }],
  ...over,
});

describe("summary", () => {
  test("requests are parents: a call with two models counts once, tokens count once each", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(call({ details: [
      { model: "claude-sonnet-4-6", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { model: "claude-haiku-4-5", inputTokens: 20, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ] }));
    ledger.recordCall(call());
    const s = reporter.summary();
    expect(s.totalRequests).toBe(2);
    expect(s.totalInputTokens).toBe(1030);
    expect(s.totalOutputTokens).toBe(112);
  });

  test("legacy rows are not in the v2 totals and appear in the legacy section as stored", () => {
    const { ledger, reporter } = setup();
    ledger.log({ sessionId: "old", agentId: "bruno", provider: "router", model: "glm-5.1", inputTokens: 500, outputTokens: 50, cacheReadTokens: 10 });
    ledger.recordCall(call());
    const s = reporter.summary();
    expect(s.totalRequests).toBe(1);
    expect(s.totalInputTokens).toBe(1000);
    expect(reporter.legacy().summary).toMatchObject({ totalRequests: 1, totalInputTokens: 500, totalOutputTokens: 50, cacheReadTokens: 10 });
    expect(reporter.legacy().byProvider).toEqual([expect.objectContaining({ provider: "router", requestCount: 1 })]);
  });

  test("unknown and partial calls are counted next to the known estimate and mark it incomplete", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(call());
    ledger.recordCall(call({ status: "error", coverage: "unknown", details: [{ model: "unknown", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }] }));
    ledger.recordCall(call({ coverage: "partial", details: [{ model: "claude-sonnet-4-6", inputTokens: 5, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null }] }));
    const s = reporter.summary();
    expect(s).toMatchObject({ totalRequests: 3, unknownCalls: 1, partialCalls: 1, estimateComplete: false });
    expect(s.totalInputTokens).toBe(1005);
  });

  test("a report with only complete calls is complete", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(call());
    expect(reporter.summary()).toMatchObject({ unknownCalls: 0, partialCalls: 0, estimateComplete: true });
  });

  test("cache-write is priced: 1,000,000 tokens at 3.75 per million costs 3.75", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(call({ details: [{ model: "claude-sonnet-4-6", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 }] }));
    const s = reporter.summary();
    expect(s.cacheWriteTokens).toBe(1_000_000);
    expect(s.estimatedCost).toBe(3.75);
  });

  test("NULL counts add nothing to the estimate (they are not guessed)", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(call({ coverage: "unknown", details: [{ model: "claude-sonnet-4-6", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }] }));
    expect(reporter.summary().estimatedCost).toBe(0);
  });

  test("the price table is read once for a report over 17,885 details", () => {
    let loads = 0;
    const { db, reporter } = setup(() => { loads++; return PRICES; });
    const ledger = new TokenLedger(db);
    db.transaction(() => {
      for (let i = 0; i < 17_885; i++) ledger.recordCall(call({ callId: `bulk-${i}` }));
    })();
    loads = 0;
    const s = reporter.summary();
    expect(loads).toBe(1);
    expect(s.totalRequests).toBe(17_885);
    expect(s.estimatedCost).toBeCloseTo(17_885 * (1000 * 3 + 100 * 15) / 1_000_000, 4);
  });
});

describe("pricing is labelled, not assumed", () => {
  const priced = (model: string, backend = "claude") => call({ backend, details: [{ model, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }] });

  test("a dated or suffixed model id is priced at its alias and is not flagged", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(priced("claude-sonnet-4-6-20260101"));
    ledger.recordCall(priced("claude-sonnet-4-6[1m]"));
    const s = reporter.summary();
    expect(s.estimatedCost).toBe(6);
    expect(s.fallbackPriced).toEqual([]);
    expect(s.estimateComplete).toBe(true);
  });

  test("a model with no price entry is priced at the provider default, listed, and marks the estimate incomplete", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(priced("mystery-model"));
    ledger.recordCall(priced("mystery-model"));
    const s = reporter.summary();
    expect(s.estimatedCost).toBe(6);
    expect(s.fallbackPriced).toEqual([{ provider: "claude", model: "mystery-model", calls: 2 }]);
    expect(s.estimateComplete).toBe(false);
  });

  test("an unknown model and a provider with no price table are flagged too", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(priced("unknown"));
    ledger.recordCall(priced("some-model", "newcloud"));
    expect(reporter.summary().fallbackPriced.map((f) => f.model).sort()).toEqual(["some-model", "unknown"]);
  });

  test("a plan or free price is never a guess: an unlisted model on a plan provider is not flagged", () => {
    const withPlan: PricingConfig = { ...PRICES, gemini: { default: { input: 0, output: 0, plan: true } } };
    const { ledger, reporter } = setup(() => withPlan);
    ledger.recordCall(priced("gemini-9-new", "gemini"));
    expect(reporter.summary()).toMatchObject({ fallbackPriced: [], estimatedCost: 0, estimateComplete: true });
  });
});

describe("breakdowns", () => {
  test("by model counts distinct calls and says it is not additive", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(call({ details: [
      { model: "claude-sonnet-4-6", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { model: "claude-haiku-4-5", inputTokens: 20, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ] }));
    ledger.recordCall(call());
    const rows = reporter.byModel();
    const sonnet = rows.find((r) => r.model === "claude-sonnet-4-6")!;
    const haiku = rows.find((r) => r.model === "claude-haiku-4-5")!;
    expect(sonnet).toMatchObject({ requestCount: 2, nonAdditive: true });
    expect(haiku).toMatchObject({ requestCount: 1, nonAdditive: true });
  });

  test("by agent, by provider and by agent-model count parents, never detail rows", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(call({ agentId: "bruno", backend: "claude", details: [
      { model: "claude-sonnet-4-6", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { model: "claude-haiku-4-5", inputTokens: 20, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ] }));
    ledger.recordCall(call({ agentId: "eli", backend: "minimax", details: [{ model: "MiniMax-M3", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }] }));
    expect(reporter.byAgent().find((r) => r.agentId === "bruno")).toMatchObject({ requestCount: 1, totalInputTokens: 30, totalOutputTokens: 12, totalTokens: 42 });
    expect(reporter.byProvider().find((r) => r.provider === "claude")).toMatchObject({ requestCount: 1, totalInputTokens: 30 });
    expect(reporter.byAgentModel().filter((r) => r.agentId === "bruno").map((r) => r.requestCount)).toEqual([1, 1]);
  });
});

describe("date ranges", () => {
  const noon = "2026-10-22T12:00:00.000Z";
  const total = (r: CostReporter, f: { since?: string; until?: string }) => r.summary(f).totalRequests;

  test("a noon-UTC call is in the day given by an ISO midnight since and a date-only until", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(call({ startedAt: noon }));
    expect(total(reporter, { since: "2026-10-22T00:00:00Z", until: "2026-10-22" })).toBe(1);
    expect(total(reporter, { since: "2026-10-22", until: "2026-10-22" })).toBe(1);
    expect(total(reporter, { since: "2026-10-23" })).toBe(0);
    expect(total(reporter, { until: "2026-10-21" })).toBe(0);
  });

  test("until is exclusive to the exact instant, with fractions and offsets; since is inclusive", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(call({ startedAt: "2026-10-22T12:00:00.250Z" }));
    expect(total(reporter, { until: "2026-10-22T12:00:00.250Z" })).toBe(0);
    expect(total(reporter, { until: "2026-10-22T12:00:00.251Z" })).toBe(1);
    expect(total(reporter, { since: "2026-10-22T12:00:00.250Z" })).toBe(1);
    expect(total(reporter, { since: "2026-10-22T12:00:00.251Z" })).toBe(0);
    expect(total(reporter, { until: "2026-10-22T19:00:00.250+07:00" })).toBe(0);
    expect(total(reporter, { since: "2026-10-22T19:00:00.250+07:00" })).toBe(1);
  });

  test("a date-time without a zone is read as UTC, not local time", () => {
    expect(parseRange({ since: "2026-10-22T12:00:00" }).since).toBe("2026-10-22T12:00:00.000Z");
  });

  test("invalid dates are rejected with a clear error", () => {
    expect(() => parseRange({ since: "not-a-date" })).toThrow(/since/);
    expect(() => parseRange({ until: "2026-13-45" })).toThrow(/until/);
    const { reporter } = setup();
    expect(() => reporter.summary({ since: "yesterday" })).toThrow(RangeError);
  });

  test("the same exclusive range applies to legacy rows, read as UTC", () => {
    const { db, ledger, reporter } = setup();
    ledger.log({ sessionId: "o", agentId: "bruno", provider: "p", model: "m", inputTokens: 1, outputTokens: 1 });
    db.run("UPDATE token_usage SET created_at = '2026-10-22 12:00:00'");
    expect(reporter.legacy({ since: "2026-10-22T12:00:00Z" }).summary.totalRequests).toBe(1);
    expect(reporter.legacy({ until: "2026-10-22T12:00:00Z" }).summary.totalRequests).toBe(0);
    expect(reporter.legacy({ until: "2026-10-22" }).summary.totalRequests).toBe(1);
  });

  test("the agent filter applies to calls and legacy rows", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(call({ agentId: "bruno" }));
    ledger.recordCall(call({ agentId: "eli" }));
    expect(reporter.summary({ agentId: "eli" }).totalRequests).toBe(1);
  });
});

describe("a database not yet migrated (the dashboard opens it read-only)", () => {
  test("v2 sections are empty and every row is legacy, with no error", () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    db.run("INSERT INTO token_usage (session_id, agent_id, provider, model, input_tokens, output_tokens, created_at) VALUES ('s','bruno','claude','claude-sonnet-4-6',1000,100,'2026-10-22 12:00:00')");
    const reporter = new CostReporter(db, { loadPricing: () => PRICES });
    expect(reporter.summary()).toMatchObject({ totalRequests: 0, estimateComplete: true });
    expect(reporter.byModel()).toEqual([]);
    expect(reporter.legacy().summary).toMatchObject({ totalRequests: 1, totalInputTokens: 1000 });
  });

  test("a database with no tables yet (opened before any provider settled) reports empty legacy sections, with no error", () => {
    const reporter = new CostReporter(new Database(":memory:"), { loadPricing: () => PRICES });
    expect(reporter.summary()).toMatchObject({ totalRequests: 0 });
    expect(reporter.legacy()).toEqual({
      summary: { totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 0 },
      byModel: [], byAgent: [], byAgentModel: [], byProvider: [],
    });
  });
});
