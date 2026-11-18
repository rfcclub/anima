/**
 * cost-ledger-accuracy: the dashboard API shows the v2 report next to a
 * labelled legacy section, and rejects an invalid date range instead of guessing.
 * The database is a temp file named by ANIMA_COST_DB.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenLedger } from "../../src/cost/ledger";
import { handleCost } from "../../src/ui/features/cost/api/cost";

let dir: string;
const saved = process.env.ANIMA_COST_DB;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cost-api-"));
  const path = join(dir, "cost.db");
  const db = new Database(path, { create: true });
  const ledger = new TokenLedger(db);
  ledger.log({ sessionId: "old", agentId: "bruno", provider: "router", model: "glm-5.1", inputTokens: 500, outputTokens: 50 });
  ledger.recordCall({ callId: "c1", agentId: "bruno", sessionId: "s1", backend: "claude", startedAt: "2026-10-22T12:00:00.000Z", latencyMs: 10, status: "ok", coverage: "complete", details: [{ model: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }] });
  db.close();
  process.env.ANIMA_COST_DB = path;
});

afterAll(() => {
  if (saved === undefined) delete process.env.ANIMA_COST_DB; else process.env.ANIMA_COST_DB = saved;
  rmSync(dir, { recursive: true, force: true });
});

test("the response carries the v2 report and a labelled legacy section", async () => {
  const res = handleCost(new Request("http://x.invalid/api/cost"));
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.summary).toMatchObject({ totalRequests: 1, totalInputTokens: 100, unknownCalls: 0, estimateComplete: true });
  expect(body.legacy.summary).toMatchObject({ totalRequests: 1, totalInputTokens: 500 });
  expect(body.byModel[0]).toMatchObject({ model: "claude-sonnet-4-6", nonAdditive: true });
});

test("an invalid since is a 400 with a message, not a wrong total", async () => {
  const res = handleCost(new Request("http://x.invalid/api/cost?since=not-a-date"));
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toMatch(/since/);
});

test("a date-only until includes that whole UTC day", async () => {
  const res = handleCost(new Request("http://x.invalid/api/cost?since=2026-10-22&until=2026-10-22"));
  expect((await res.json() as any).summary.totalRequests).toBe(1);
});
