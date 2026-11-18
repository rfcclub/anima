/**
 * TokenLedger — TDD tests
 * Cost tracking for ANIMA: per-request token logging, aggregation, reporting.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";

let db: Database;
let ledger: any;
let reporter: any;

beforeAll(async () => {
  db = new Database(":memory:");
  const { TokenLedger } = await import("../../src/cost/ledger");
  const { CostReporter } = await import("../../src/cost/reporter");
  ledger = new TokenLedger(db);
  reporter = new CostReporter(db);
});

afterAll(() => db?.close());

describe("TokenLedger — Log", () => {
  test("log single request returns id", () => {
    const id = ledger.log({
      sessionId: "sess-1",
      agentId: "bruno",
      provider: "claude",
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
    });
    expect(id).toBeGreaterThan(0);
  });

  test("log multiple requests from different agents", () => {
    ledger.log({ sessionId: "sess-1", agentId: "bruno", provider: "claude", model: "claude-sonnet-4-6", inputTokens: 500, outputTokens: 100 });
    ledger.log({ sessionId: "sess-1", agentId: "eli", provider: "gemini", model: "gemini-2.5-flash", inputTokens: 300, outputTokens: 50 });
    ledger.log({ sessionId: "sess-2", agentId: "bruno", provider: "minimax", model: "MiniMax-M3", inputTokens: 2000, outputTokens: 400, cacheReadTokens: 800 });
  });

  test("log with missing optional fields defaults to 0", () => {
    const id = ledger.log({
      sessionId: "sess-3",
      agentId: "milo",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      inputTokens: 100,
      outputTokens: 50,
    });
    const row = db.query("SELECT * FROM token_usage WHERE id = ?").get(id) as any;
    expect(row.cache_read_tokens).toBe(0);
    expect(row.cache_write_tokens).toBe(0);
  });
});

// ledger.log() writes legacy (v1) rows, which CostReporter reports in its legacy section
// (cost-ledger-accuracy); v2 call counting is covered by reporter-v2.test.ts.
describe("CostReporter — Aggregation", () => {
  beforeAll(() => {
    // Seed test data
    ledger.log({ sessionId: "rpt-1", agentId: "bruno", provider: "claude", model: "claude-sonnet-4-6", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300 });
    ledger.log({ sessionId: "rpt-1", agentId: "bruno", provider: "claude", model: "claude-sonnet-4-6", inputTokens: 2000, outputTokens: 300 });
    ledger.log({ sessionId: "rpt-1", agentId: "eli", provider: "minimax", model: "MiniMax-M3", inputTokens: 500, outputTokens: 100 });
    ledger.log({ sessionId: "rpt-2", agentId: "bruno", provider: "minimax", model: "MiniMax-M3", inputTokens: 3000, outputTokens: 500, cacheReadTokens: 1000 });
  });

  test("total tokens by model", () => {
    const byModel = reporter.legacy().byModel;
    expect(byModel.length).toBeGreaterThan(0);
    const claude = byModel.find((m: any) => m.model === "claude-sonnet-4-6");
    expect(claude).toBeDefined();
    // bruno claude: 1000+500 (Log) + 1000+2000 (Agg beforeAll) = 4500
    expect(claude.totalInputTokens).toBeGreaterThanOrEqual(3000);
    expect(claude.requestCount).toBeGreaterThanOrEqual(2);
  });

  test("total tokens by agent", () => {
    const byAgent = reporter.legacy().byAgent;
    const bruno = byAgent.find((a: any) => a.agentId === "bruno");
    expect(bruno).toBeDefined();
    expect(bruno.totalTokens).toBeGreaterThan(0);
    expect(bruno.requestCount).toBeGreaterThan(0);
  });

  test("total tokens by agent and model", () => {
    const byAgentModel = reporter.legacy().byAgentModel;
    const brunoClaude = byAgentModel.find((a: any) => a.agentId === "bruno" && a.model === "claude-sonnet-4-6");
    expect(brunoClaude).toBeDefined();
    expect(brunoClaude.totalInputTokens).toBeGreaterThanOrEqual(3000);
    expect(brunoClaude.requestCount).toBeGreaterThanOrEqual(2);
  });

  test("summary returns totals", () => {
    const summary = reporter.legacy().summary;
    expect(summary.totalRequests).toBeGreaterThan(0);
    expect(summary.totalInputTokens).toBeGreaterThan(0);
    expect(summary.cacheReadTokens).toBeGreaterThanOrEqual(0);
  });

  test("summary with time range filters correctly", () => {
    const allTime = reporter.legacy().summary;
    // Future time range returns 0
    const future = reporter.legacy({ since: "2099-01-01T00:00:00Z" }).summary;
    expect(future.totalRequests).toBe(0);
  });

  test("byProvider returns grouped results", () => {
    const byProv = reporter.legacy().byProvider;
    expect(byProv.length).toBeGreaterThanOrEqual(1);
    const claude = byProv.find((p: any) => p.provider === "claude");
    expect(claude).toBeDefined();
  });
});

describe("TokenLedger — Cache tracking", () => {
  test("cache_read_tokens is tracked correctly", () => {
    ledger.log({ sessionId: "cache-1", agentId: "bruno", provider: "minimax", model: "MiniMax-M3", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400 });
    ledger.log({ sessionId: "cache-1", agentId: "bruno", provider: "minimax", model: "MiniMax-M3", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400 });

    const summary = reporter.legacy().summary;
    expect(summary.cacheReadTokens).toBeGreaterThanOrEqual(800);
  });

  test("cache_write_tokens is tracked", () => {
    ledger.log({ sessionId: "cache-w", agentId: "bruno", provider: "claude", model: "claude-opus-4-8", inputTokens: 2000, outputTokens: 300, cacheWriteTokens: 2000 });
    const summary = reporter.legacy().summary;
    expect(summary.cacheWriteTokens).toBeGreaterThanOrEqual(2000);
  });
});
