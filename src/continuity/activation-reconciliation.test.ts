import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivationStore } from "./activation-store";
import { reconcileActivation } from "./activation-reconciliation";

test("SC-012: reconciliation is read-only and identifies an acked projected delivery", () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-reconcile-"));
  const activationPath = join(dir, "activation.db");
  const meshPath = join(dir, "mesh.db");
  const activation = new ActivationStore(activationPath);
  const mesh = new Database(meshPath);
  try {
    activation.projectAttention({ agentId: "eli", sourceKind: "mesh", sourceRef: "mesh:42", occurrenceKey: "mesh:42", kind: "request", urgency: 5, summary: "review", openedAt: 1, dueAt: 1, lastEventId: "mesh:42" });
    const resolved = activation.projectAttention({ agentId: "eli", sourceKind: "mesh", sourceRef: "mesh:43", occurrenceKey: "mesh:43", kind: "request", urgency: 5, summary: "done", openedAt: 1, dueAt: 1, lastEventId: "mesh:43" });
    const claimed = activation.transitionAttention(resolved.id, resolved.version, "claimed", 2);
    if (!claimed.ok) throw new Error("could not claim fixture");
    const acted = activation.transitionAttention(claimed.item.id, claimed.item.version, "acted", 3);
    if (!acted.ok) throw new Error("could not act fixture");
    if (!activation.transitionAttention(acted.item.id, acted.item.version, "resolved", 4).ok) throw new Error("could not resolve fixture");
    const active = activation.projectAttention({ agentId: "eli", sourceKind: "mesh", sourceRef: "mesh:44", occurrenceKey: "mesh:44", kind: "request", urgency: 5, summary: "running", openedAt: 1, dueAt: 1, lastEventId: "mesh:44" });
    if (!activation.transitionAttention(active.id, active.version, "claimed", 2).ok) throw new Error("could not claim active fixture");
    activation.acquireLease({ id: "lease-44", candidateKey: "eli:mesh:mesh:44:mesh:44", agentId: "eli", executor: "mesh-session", costClass: "T1", now: 1, expiresAt: 20_000 });
    mesh.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY)");
    mesh.exec("CREATE TABLE deliveries (id INTEGER PRIMARY KEY, message_id INTEGER, recipient_id TEXT, claimed_at TEXT, acked_at TEXT, failed_at TEXT)");
    mesh.exec("INSERT INTO messages (id) VALUES (42), (43), (44)");
    mesh.exec("INSERT INTO deliveries (id, message_id, recipient_id, claimed_at, acked_at) VALUES (7, 42, 'eli', '1970-01-01T00:00:01.000Z', '1970-01-01T00:00:02.000Z'), (8, 43, 'eli', NULL, '1970-01-01T00:00:03.000Z'), (9, 44, 'eli', '1970-01-01T00:00:03.000Z', '1970-01-01T00:00:03.000Z')");
    mesh.close();
    activation.close();

    const report = reconcileActivation({ activationDbPath: activationPath, meshDbPath: meshPath, now: 10_000 });
    expect(report).toEqual([{
      deliveryId: 7, messageId: 42, sourceRef: "mesh:42", agentId: "eli", attentionState: "open",
      claimedAt: "1970-01-01T00:00:01.000Z", ackedAt: "1970-01-01T00:00:02.000Z",
      leaseStatus: null, recommendation: "broker-enqueue",
    }, {
      deliveryId: 8, messageId: 43, sourceRef: "mesh:43", agentId: "eli", attentionState: "resolved",
      claimedAt: null, ackedAt: "1970-01-01T00:00:03.000Z", leaseStatus: null, recommendation: "verify-durable-effect",
    }, {
      deliveryId: 9, messageId: 44, sourceRef: "mesh:44", agentId: "eli", attentionState: "claimed",
      claimedAt: "1970-01-01T00:00:03.000Z", ackedAt: "1970-01-01T00:00:03.000Z", leaseStatus: "active", recommendation: "wait-for-lease",
    }]);

    const check = new Database(activationPath, { readonly: true });
    expect((check.query("SELECT COUNT(*) AS count FROM attention_items").get() as { count: number }).count).toBe(3);
    check.close();
  } finally {
    try { activation.close(); } catch {}
    try { mesh.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
