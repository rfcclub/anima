import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivationBudget } from "./activation-budget";
import { ActivationStore } from "./activation-store";

test("SC-037 T0 creates a zero-cost grant and SC-041 validates executor/expiry", () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-budget-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  try {
    const budget = new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 });
    const reserved = budget.reserve({ leaseId: "l1", agentId: "eli", executor: "movement", costClass: "T0", now: 1_000 });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(budget.isValidGrant(reserved.grant, { agentId: "eli", executor: "movement", now: 1_001 })).toBe(true);
    expect(budget.isValidGrant(reserved.grant, { agentId: "eli", executor: "reflection", now: 1_001 })).toBe(false);
    expect(store.budgetRowCount()).toBe(0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SC-040 settles a T1 grant once", () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-budget-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  try {
    const budget = new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 });
    const reserved = budget.reserve({ leaseId: "l1", agentId: "eli", executor: "reflection", costClass: "T1", now: 1_000 });
    expect(reserved.ok).toBe(true);
    expect(budget.settle("l1", 1_001)).toBe(true);
    expect(budget.settle("l1", 1_002)).toBe(false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
