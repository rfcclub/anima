/**
 * cost-ledger-accuracy: a test run must never write into the live
 * ~/.anima/cost.db through the process ledger.
 */

import { test, expect } from "bun:test";
import { openCostDb, resolveCostDbPath } from "../../src/cost/logger";

test("under a test run the process ledger is in memory unless ANIMA_COST_DB says otherwise", () => {
  expect(resolveCostDbPath({ NODE_ENV: "test", HOME: "/home/user" })).toBe(":memory:");
  expect(resolveCostDbPath({ NODE_ENV: "test", HOME: "/home/user", ANIMA_COST_DB: "/tmp/t/cost.db" })).toBe("/tmp/t/cost.db");
});

test("outside a test run it is ~/.anima/cost.db, or ANIMA_COST_DB when set", () => {
  expect(resolveCostDbPath({ HOME: "/home/user" })).toBe("/home/user/.anima/cost.db");
  expect(resolveCostDbPath({ NODE_ENV: "production", HOME: "/home/user" })).toBe("/home/user/.anima/cost.db");
  expect(resolveCostDbPath({ HOME: "/home/user", ANIMA_COST_DB: "/data/cost.db" })).toBe("/data/cost.db");
});

test("the process ledger waits a bounded time for a busy database instead of dropping the record at once", () => {
  const db = openCostDb(":memory:");
  const row = db.query("PRAGMA busy_timeout").get() as Record<string, number>;
  expect(Object.values(row)[0]).toBe(100);
});
