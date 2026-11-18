import { describe, expect, test } from "bun:test";
import type { MeshDelivery } from "colony-mesh";
import { MeshIngress } from "./mesh-ingress";

function delivery(role: string, overrides: Partial<MeshDelivery["message"]> = {}): MeshDelivery {
  return {
    delivery_id: 7, message_id: 42, recipient_id: "eli", delivery_kind: "direct", topic: null,
    available_at: "2026-07-14T00:00:00.000Z", claimed_at: null, claim_expires_at: null, claim_token: "claim",
    acked_at: null, failed_at: null, failure_reason: null, attempts: 0,
    message: { id: 42, client_msg_id: null, thread_id: null, pattern: "direct", role, from_id: "bruno", from_platform: "oc", to_platform: "anima", subject: "hello", content: "please review", round: null, context_only: false, created_at: "2026-07-14T00:00:00.000Z", ...overrides } as MeshDelivery["message"],
  };
}

describe("MeshIngress", () => {
  test("SC-004 projects a request before reporting ack", () => {
    const calls: string[] = [];
    const ingress = new MeshIngress({
      project: (input) => { calls.push(`project:${input.sourceRef}`); },
      wake: () => calls.push("wake"),
    });
    expect(ingress.ingest("eli", delivery("request"))).toEqual({ disposition: "ack", route: "candidate" });
    expect(calls).toEqual(["project:mesh:42", "wake"]);
  });

  test("SC-005 fails closed for unknown and terminal roles", () => {
    const calls: string[] = [];
    const ingress = new MeshIngress({ project: () => { calls.push("project"); }, wake: () => calls.push("wake") });
    expect(ingress.ingest("eli", delivery("unrecognized"))).toEqual({ disposition: "ack", route: "informational" });
    expect(ingress.ingest("eli", delivery("result"))).toEqual({ disposition: "ack", route: "informational" });
    expect(calls).toEqual([]);
  });

  test("SC-006 routes a knock only to one wake path", () => {
    let wakes = 0;
    let projections = 0;
    const ingress = new MeshIngress({ project: () => { projections++; }, wake: () => { wakes++; } });
    expect(ingress.ingest("eli", delivery("knock"))).toEqual({ disposition: "ack", route: "wake" });
    expect(wakes).toBe(1);
    expect(projections).toBe(0);
  });

  test("SC-003 returns retry when durable projection fails", () => {
    const ingress = new MeshIngress({ project: () => { throw new Error("db busy"); }, wake: () => {} });
    expect(ingress.ingest("eli", delivery("request"))).toEqual({ disposition: "retry", route: "candidate" });
  });
});
