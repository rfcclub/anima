import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivationStore } from "./activation-store";

const directories: string[] = [];

function makeStore(): ActivationStore {
  const dir = mkdtempSync(join(tmpdir(), "activation-store-"));
  directories.push(dir);
  return new ActivationStore(join(dir, "memory.db"));
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ActivationStore", () => {
  test("SC-007 creates idempotent attention schema and indexes", () => {
    const store = makeStore();
    try {
      expect(store.schemaObjects()).toEqual(expect.arrayContaining([
        "attention_items",
        "activation_leases",
        "activation_budgets",
        "idx_attention_agent_state_due",
      ]));
    } finally {
      store.close();
    }

    const reopened = new ActivationStore(join(directories[0]!, "memory.db"));
    try {
      expect(reopened.schemaObjects()).toContain("idx_attention_agent_state_due");
    } finally {
      reopened.close();
    }
  });

  test("SC-010 rejects a stale attention transition without changing state", () => {
    const store = makeStore();
    try {
      const item = store.projectAttention({
        agentId: "eli",
        sourceKind: "mesh",
        sourceRef: "mesh:1",
        occurrenceKey: "mesh:1",
        kind: "request",
        urgency: 5,
        summary: "Review a request",
        openedAt: 100,
        dueAt: 200,
        lastEventId: "event-1",
      });
      expect(store.transitionAttention(item.id, item.version, "claimed", 150).ok).toBe(true);
      expect(store.transitionAttention(item.id, item.version, "claimed", 151)).toEqual({
        ok: false,
        reason: "version-conflict",
      });
      expect(store.getAttention(item.id)?.state).toBe("claimed");
    } finally {
      store.close();
    }
  });

  test("SC-009 performs the legal attention lifecycle", () => {
    const store = makeStore();
    try {
      const opened = store.projectAttention({ agentId: "eli", sourceKind: "mesh", sourceRef: "mesh:9", occurrenceKey: "mesh:9", kind: "request", urgency: 1, summary: "lifecycle", openedAt: 1, dueAt: 1, lastEventId: "event-9" });
      const claimed = store.transitionAttention(opened.id, opened.version, "claimed", 2);
      expect(claimed.ok && claimed.item.state).toBe("claimed");
      const acted = store.transitionAttention(opened.id, claimed.ok ? claimed.item.version : 0, "acted", 3);
      expect(acted.ok && acted.item.state).toBe("acted");
      const resolved = store.transitionAttention(opened.id, acted.ok ? acted.item.version : 0, "resolved", 4);
      expect(resolved.ok && resolved.item.state).toBe("resolved");
    } finally { store.close(); }
  });

  test("SC-032 permits only one active lease per candidate", () => {
    const store = makeStore();
    try {
      expect(store.acquireLease({
        id: "lease-1", candidateKey: "mesh:1", agentId: "eli", executor: "mesh-session", costClass: "T1", now: 100, expiresAt: 200,
      }).ok).toBe(true);
      expect(store.acquireLease({
        id: "lease-2", candidateKey: "mesh:1", agentId: "eli", executor: "mesh-session", costClass: "T1", now: 101, expiresAt: 201,
      })).toEqual({ ok: false, reason: "already-leased" });
    } finally {
      store.close();
    }
  });

  test("SC-033 releases an expired pre-effect lease and its reservation", () => {
    const store = makeStore();
    try {
      store.acquireLease({ id: "lease-1", candidateKey: "mesh:1", agentId: "eli", executor: "reflection", costClass: "T1", now: 1, expiresAt: 10 });
      expect(store.reserveBudget({ leaseId: "lease-1", day: "2026-07-14", agentId: "eli", units: 1, colonyLimit: 10, agentLimit: 10, now: 1 })).toEqual({ ok: true });
      expect(store.releaseExpiredLeases(10)).toEqual(["lease-1"]);
      expect(store.getBudget("2026-07-14", "colony", "all")).toEqual({ spentUnits: 0, reservedUnits: 0 });
      expect(store.getBudget("2026-07-14", "agent", "eli")).toEqual({ spentUnits: 0, reservedUnits: 0 });
      expect(store.acquireLease({ id: "lease-2", candidateKey: "mesh:1", agentId: "eli", executor: "reflection", costClass: "T1", now: 11, expiresAt: 20 }).ok).toBe(true);
    } finally { store.close(); }
  });

  test("SC-038 and SC-039 reject dual-scope budget reservation atomically", () => {
    const store = makeStore();
    try {
      expect(store.reserveBudget({ leaseId: "agent-reject", day: "2026-07-14", agentId: "eli", units: 10, colonyLimit: 100, agentLimit: 5, now: 1 }))
        .toEqual({ ok: false, reason: "agent-budget" });
      expect(store.getBudget("2026-07-14", "colony", "all")).toEqual({ spentUnits: 0, reservedUnits: 0 });
      expect(store.getBudget("2026-07-14", "agent", "eli")).toEqual({ spentUnits: 0, reservedUnits: 0 });
      expect(store.budgetRowCount()).toBe(0);

      expect(store.reserveBudget({ leaseId: "colony-reject", day: "2026-07-14", agentId: "eli", units: 10, colonyLimit: 5, agentLimit: 100, now: 1 }))
        .toEqual({ ok: false, reason: "colony-budget" });
      expect(store.getBudget("2026-07-14", "colony", "all")).toEqual({ spentUnits: 0, reservedUnits: 0 });
      expect(store.getBudget("2026-07-14", "agent", "eli")).toEqual({ spentUnits: 0, reservedUnits: 0 });
      expect(store.budgetRowCount()).toBe(0);
    } finally {
      store.close();
    }
  });

  test("SC-040 settles a reservation once", () => {
    const store = makeStore();
    try {
      expect(store.reserveBudget({ leaseId: "lease-1", day: "2026-07-14", agentId: "eli", units: 10, colonyLimit: 100, agentLimit: 100, now: 1 }).ok).toBe(true);
      expect(store.settleBudget("lease-1", 2)).toBe(true);
      expect(store.settleBudget("lease-1", 3)).toBe(false);
      expect(store.getBudget("2026-07-14", "colony", "all")).toEqual({ spentUnits: 10, reservedUnits: 0 });
      expect(store.getBudget("2026-07-14", "agent", "eli")).toEqual({ spentUnits: 10, reservedUnits: 0 });
    } finally {
      store.close();
    }
  });

  test("operational status exposes only bounded durable counters", () => {
    const store = makeStore();
    try {
      store.projectAttention({ agentId: "eli", sourceKind: "mesh", sourceRef: "mesh:status", occurrenceKey: "mesh:status", kind: "request", urgency: 5, summary: "secret request", openedAt: 1, dueAt: 10, lastEventId: "event-status" });
      store.acquireLease({ id: "lease-status", candidateKey: "eli:mesh:mesh:status:mesh:status", agentId: "eli", executor: "mesh-session", costClass: "T1", now: 1, expiresAt: 100 });
      store.reserveBudget({ leaseId: "lease-status", day: "1970-01-01", agentId: "eli", units: 1, colonyLimit: 10, agentLimit: 10, now: 1 });
      expect(store.operationalStatus(10)).toEqual({ activeLeases: 1, dueAttention: 1, nextLeaseExpiry: 100, budgets: [
        { day: "1970-01-01", scope: "agent", scopeId: "eli", spentUnits: 0, reservedUnits: 1 },
        { day: "1970-01-01", scope: "colony", scopeId: "all", spentUnits: 0, reservedUnits: 1 },
      ], serviceAges: [] });
    } finally { store.close(); }
  });

  test("persists cooldowns by agent and key", () => {
    const store = makeStore();
    try {
      expect(store.getCooldown("eli", "social:bruno")).toBeNull();
      store.setCooldown("eli", "social:bruno", 500);
      expect(store.getCooldown("eli", "social:bruno")).toBe(500);
      store.setCooldown("eli", "social:bruno", 700);
      expect(store.getCooldown("eli", "social:bruno")).toBe(700);
    } finally {
      store.close();
    }
  });
});
