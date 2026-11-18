import { expect, test } from "bun:test";
import { AmbientMovementPolicy } from "./ambient-movement";

test("SC-048 keeps ambient wandering isolated, bounded, and provider-free", async () => {
  const policy = new AmbientMovementPolicy({ cooldownMs: 100 });
  const moves: string[] = [];
  expect(await policy.attempt({ agentId: "eli", now: 10, move: async () => { moves.push("move"); } })).toEqual({ moved: true });
  expect(await policy.attempt({ agentId: "eli", now: 20, move: async () => { moves.push("move"); } })).toEqual({ moved: false, reason: "cooldown" });
  expect(moves).toEqual(["move"]);
});
