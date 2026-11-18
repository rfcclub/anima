import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeEventStore } from "../../../src/identity-runtime/contract/runtime-events.ts";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("RuntimeEventStore mutation age (M2)", () => {
  test("claimMutation records when the row was claimed", () => {
    root = mkdtempSync(join(tmpdir(), "runtime-events-"));
    const store = new RuntimeEventStore(join(root, "events.db"));

    store.claimMutation("bruno", "lease-1", "remember", "k1", 5_000);

    expect(store.pendingMutations("bruno")).toEqual([
      { leaseId: "lease-1", operation: "remember", idempotencyKey: "k1", createdAt: 5_000 },
    ]);
  });

  test("defaults created_at to now() when not supplied", () => {
    root = mkdtempSync(join(tmpdir(), "runtime-events-"));
    const store = new RuntimeEventStore(join(root, "events.db"));
    const before = Date.now();

    store.claimMutation("bruno", "lease-1", "remember", "k1");

    const [row] = store.pendingMutations("bruno");
    expect(row.createdAt).toBeGreaterThanOrEqual(before);
  });

  test("pendingMutations only lists rows still pending, scoped to the agent", () => {
    root = mkdtempSync(join(tmpdir(), "runtime-events-"));
    const store = new RuntimeEventStore(join(root, "events.db"));

    store.claimMutation("bruno", "lease-1", "remember", "k1", 1_000);
    store.claimMutation("bruno", "lease-2", "remember", "k2", 2_000);
    store.completeMutation("bruno", "lease-2", "remember", "k2", { id: "x", createdAt: "now" });
    store.claimMutation("eli", "lease-3", "remember", "k3", 3_000);

    expect(store.pendingMutations("bruno")).toEqual([
      { leaseId: "lease-1", operation: "remember", idempotencyKey: "k1", createdAt: 1_000 },
    ]);
    expect(store.pendingMutations("eli")).toEqual([
      { leaseId: "lease-3", operation: "remember", idempotencyKey: "k3", createdAt: 3_000 },
    ]);
  });

  test("existing DB files without the created_at column still open (migration-safe)", () => {
    root = mkdtempSync(join(tmpdir(), "runtime-events-"));
    const dbPath = join(root, "events.db");

    // Simulate a pre-migration DB: create the table without created_at, as the
    // old schema did, then reopen with the current RuntimeEventStore.
    const { Database } = require("bun:sqlite");
    const legacy = new Database(dbPath, { create: true });
    legacy.run(`
      CREATE TABLE identity_runtime_mutations (
        agent_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        PRIMARY KEY (agent_id, lease_id, operation, idempotency_key)
      )
    `);
    legacy.run(
      "INSERT INTO identity_runtime_mutations (agent_id, lease_id, operation, idempotency_key, status) VALUES (?, ?, ?, ?, 'pending')",
      ["bruno", "old-lease", "remember", "old-key"],
    );
    legacy.close();

    const store = new RuntimeEventStore(dbPath);
    expect(store.pendingMutations("bruno")).toEqual([
      { leaseId: "old-lease", operation: "remember", idempotencyKey: "old-key", createdAt: 0 },
    ]);
  });
});
