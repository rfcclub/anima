/**
 * castle-work-loop, WL-6: every execution call parent carries the work, job, claim and
 * session; the receipt of a work sums all its sessions and says what it cannot vouch for. In-memory databases only.
 */

import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { TokenLedger, type CallRecord } from "../../src/cost/ledger";
import { CostReporter } from "../../src/cost/reporter";
import { meterProvider } from "../../src/cost/meter";
import { Compactor } from "../../src/session/compactor";
import type { Provider, ProviderRequest, ProviderResponse, WorkCallLink } from "../../src/providers/interface";

const link = (over: Partial<WorkCallLink> = {}): WorkCallLink => ({ workId: "wabc1234ef0", jobId: "job-1", claimId: "claim-1", sessionNo: 1, ...over });

function call(over: Partial<CallRecord> & { callId: string }): CallRecord {
  return {
    agentId: "finn", sessionId: "s1", backend: "agnes", startedAt: "2026-10-22T12:00:00.000Z", latencyMs: 10, status: "ok", coverage: "complete",
    details: [{ model: "agnes-3.0-flash", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }], work: link(), ...over,
  };
}

function fakeProvider(): Provider {
  return {
    name: "agnes",
    async query(request: ProviderRequest): Promise<ProviderResponse> {
      return { message: { role: "assistant", content: "ok" }, usage: { input_tokens: 10, output_tokens: 5, model: request.model ?? "m", cache_categories_reported: true } };
    },
  };
}

describe("call parents carry the work links", () => {
  test("a metered call made with a work link stores workId, jobId, claimId and sessionNo", async () => {
    const db = new Database(":memory:");
    const ledger = new TokenLedger(db);
    const p = meterProvider(fakeProvider(), { ledger, path: "work" });
    await p.query({ agent: "finn", mode: "auto", messages: [], model: "agnes-3.0-flash", work: link() });
    const row = db.query("SELECT work_id, job_id, claim_id, session_no FROM provider_calls").get() as Record<string, unknown>;
    expect(row).toEqual({ work_id: "wabc1234ef0", job_id: "job-1", claim_id: "claim-1", session_no: 1 });
  });

  test("a call without a link leaves the columns empty", async () => {
    const db = new Database(":memory:");
    const p = meterProvider(fakeProvider(), { ledger: new TokenLedger(db), path: "cli" });
    await p.query({ agent: "finn", mode: "auto", messages: [], model: "m" });
    const row = db.query("SELECT work_id, session_no FROM provider_calls").get() as Record<string, unknown>;
    expect(row).toEqual({ work_id: null, session_no: null });
  });

  test("a retry and a compaction made for the work are parents with the same work id", async () => {
    const db = new Database(":memory:");
    const ledger = new TokenLedger(db);
    const p = meterProvider(fakeProvider(), { ledger, path: "work" });
    await p.query({ agent: "finn", mode: "auto", messages: [], model: "agnes-3.0-flash", work: link() });
    await p.query({ agent: "finn", mode: "auto", messages: [], model: "agnes-3.0-flash", work: link() }); // a retry is a second call
    await new Compactor({ provider: p, sessionId: "s1", model: "agnes-3.0-flash", work: link() }).summarize([
      { timestamp: "2026-10-22T12:00:00Z", role: "user", content: "hi", type: "turn", sessionId: "s1" } as never,
    ]);
    const rows = db.query("SELECT agent_id, work_id, session_no FROM provider_calls ORDER BY started_at, rowid").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.work_id === "wabc1234ef0" && r.session_no === 1)).toBe(true);
    expect(rows.map((r) => r.agent_id)).toEqual(["finn", "finn", "compactor"]);
  });

  test("a database from the earlier schema gains the columns and keeps its rows", () => {
    const db = new Database(":memory:");
    new TokenLedger(db).recordCall(call({ callId: "old", work: undefined }));
    db.run("DROP INDEX idx_provider_calls_work"); // a column cannot be dropped while an index uses it
    db.run("ALTER TABLE provider_calls DROP COLUMN work_id"); // simulate the pre-change shape
    db.run("ALTER TABLE provider_calls DROP COLUMN job_id");
    db.run("ALTER TABLE provider_calls DROP COLUMN claim_id");
    db.run("ALTER TABLE provider_calls DROP COLUMN session_no");
    const reopened = new TokenLedger(db);
    reopened.recordCall(call({ callId: "new" }));
    const rows = db.query("SELECT call_id, work_id FROM provider_calls ORDER BY call_id").all();
    expect(rows).toEqual([{ call_id: "new", work_id: "wabc1234ef0" }, { call_id: "old", work_id: null }]);
  });
});

describe("work receipt", () => {
  function setup() {
    const db = new Database(":memory:");
    // the operator's price table has an entry for the pinned model; without one the receipt says "priced at a default"
    const loadPricing = () => ({ agnes: { "agnes-3.0-flash": { input: 0.1, output: 0.4 } } });
    return { db, ledger: new TokenLedger(db), reporter: new CostReporter(db, { loadPricing }) };
  }

  test("a start session and two revise sessions add up; call count is the number of parents", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(call({ callId: "a1", work: link({ sessionNo: 1, jobId: "job-1" }) }));
    ledger.recordCall(call({ callId: "a2", work: link({ sessionNo: 1, jobId: "job-1" }) }));
    ledger.recordCall(call({ callId: "b1", work: link({ sessionNo: 2, jobId: "job-2", claimId: "claim-2" }) }));
    ledger.recordCall(call({ callId: "c1", work: link({ sessionNo: 3, jobId: "job-2", claimId: "claim-3" }) }));
    ledger.recordCall(call({ callId: "other", work: link({ workId: "wother00000" }) }));
    const r = reporter.workReceipt("wabc1234ef0");
    expect(r.calls).toBe(4);
    expect(r.sessions.map((s) => [s.sessionNo, s.calls])).toEqual([[1, 2], [2, 1], [3, 1]]);
    expect(r.totalInputTokens).toBe(4000);
    expect(r.estimatedCost).toBeGreaterThan(0);
    expect(r.estimateComplete).toBe(true);
    expect(r.complete).toBe(true);
  });

  test("a call with two models is one call, not two", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(call({
      callId: "m1",
      details: [
        { model: "agnes-3.0-flash", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        { model: "other-model", inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ],
    }));
    const r = reporter.workReceipt("wabc1234ef0");
    expect(r.calls).toBe(1);
    expect(r.totalInputTokens).toBe(150);
  });

  test("a call with unknown usage makes the receipt incomplete and says so", () => {
    const { ledger, reporter } = setup();
    ledger.recordCall(call({ callId: "ok" }));
    ledger.recordCall(call({
      callId: "unk", coverage: "unknown",
      details: [{ model: "agnes-3.0-flash", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }],
    }));
    const r = reporter.workReceipt("wabc1234ef0");
    expect(r.unknownCalls).toBe(1);
    expect(r.estimateComplete).toBe(false);
    expect(r.complete).toBe(false);
    expect(r.limits.join(" ")).toContain("no usage");
  });

  test("a pinned model with no price entry is priced at a default and the receipt says so", () => {
    const db = new Database(":memory:");
    new TokenLedger(db).recordCall(call({ callId: "x1" }));
    const r = new CostReporter(db, { loadPricing: () => ({}) }).workReceipt("wabc1234ef0");
    expect(r.fallbackPriced.length).toBe(1);
    expect(r.complete).toBe(false);
    expect(r.limits.join(" ")).toContain("provider default");
  });

  test("a work with no recorded calls has an empty, incomplete receipt", () => {
    const { reporter } = setup();
    const r = reporter.workReceipt("wnone000000");
    expect(r.calls).toBe(0);
    expect(r.complete).toBe(false);
  });

  test("a database the writer has not migrated yet gives an empty receipt instead of failing", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE token_usage (id INTEGER PRIMARY KEY, session_id TEXT, agent_id TEXT, provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, created_at TEXT)");
    expect(new CostReporter(db).workReceipt("wabc1234ef0").calls).toBe(0);
  });
});
