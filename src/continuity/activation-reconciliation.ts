import { Database } from "bun:sqlite";

export interface ActivationReconciliationOptions {
  activationDbPath: string;
  meshDbPath: string;
  now: number;
  recipientId?: string;
}

export interface ActivationReconciliationRow {
  deliveryId: number;
  messageId: number;
  sourceRef: string;
  agentId: string | null;
  attentionState: string | null;
  claimedAt: string | null;
  ackedAt: string | null;
  leaseStatus: string | null;
  recommendation: "inspect-unprojected-ack" | "project-before-ack" | "broker-enqueue" | "wait-for-lease" | "recover-pre-effect" | "verify-durable-effect";
}

/**
 * Read-only migration aid. It deliberately does not call MeshBus, ack a
 * delivery, reconcile attention, or update a lease. Operators choose the
 * recommended explicit action from its output.
 */
export function reconcileActivation(options: ActivationReconciliationOptions): ActivationReconciliationRow[] {
  const mesh = new Database(options.meshDbPath, { readonly: true });
  const activation = new Database(options.activationDbPath, { readonly: true });
  try {
    const deliveries = mesh.query(`SELECT id, message_id, recipient_id, claimed_at, acked_at
      FROM deliveries ${options.recipientId ? "WHERE recipient_id = ?" : ""} ORDER BY id ASC`)
      .all(...(options.recipientId ? [options.recipientId] : [])) as Array<{
        id: number; message_id: number; recipient_id: string; claimed_at: string | null; acked_at: string | null;
      }>;
    const attentionBySource = activation.query(`SELECT * FROM attention_items
      WHERE agent_id = ? AND source_kind = 'mesh' AND source_ref = ? ORDER BY version DESC LIMIT 1`);
    const leaseByCandidate = activation.query(`SELECT status, expires_at FROM activation_leases
      WHERE candidate_key = ? ORDER BY acquired_at DESC LIMIT 1`);
    const effectByCandidate = activation.query(`SELECT 1 FROM activation_effects WHERE candidate_key = ? LIMIT 1`);

    return deliveries.map((delivery) => {
      const sourceRef = `mesh:${delivery.message_id}`;
      const attention = attentionBySource.get(delivery.recipient_id, sourceRef) as Record<string, unknown> | null;
      if (!attention) {
        return {
          deliveryId: delivery.id, messageId: delivery.message_id, sourceRef, agentId: null, attentionState: null,
          claimedAt: delivery.claimed_at, ackedAt: delivery.acked_at, leaseStatus: null,
          recommendation: delivery.acked_at ? "inspect-unprojected-ack" : "project-before-ack",
        };
      }
      const candidateKey = `${attention.agent_id}:${attention.source_kind}:${attention.source_ref}:${attention.occurrence_key}`;
      const lease = leaseByCandidate.get(candidateKey) as { status: string; expires_at: number } | null;
      const hasEffect = Boolean(effectByCandidate.get(candidateKey));
      const attentionState = attention.state as string;
      return {
        deliveryId: delivery.id, messageId: delivery.message_id, sourceRef, agentId: attention.agent_id as string,
        attentionState, claimedAt: delivery.claimed_at, ackedAt: delivery.acked_at, leaseStatus: lease?.status ?? null,
        recommendation: recommendation(attentionState, lease, hasEffect, options.now),
      };
    });
  } finally {
    activation.close();
    mesh.close();
  }
}

function recommendation(state: string, lease: { status: string; expires_at: number } | null, hasEffect: boolean, now: number): ActivationReconciliationRow["recommendation"] {
  if (state === "open") return "broker-enqueue";
  if (state !== "claimed") return "verify-durable-effect";
  if (lease?.status === "active" && lease.expires_at > now) return "wait-for-lease";
  return hasEffect ? "verify-durable-effect" : "recover-pre-effect";
}
