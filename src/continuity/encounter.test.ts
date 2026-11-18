import { expect, test } from "bun:test";
import { detectEncounter } from "./encounter";

test("co-present free agents can form one cooldown-gated encounter in a chamber", () => {
  const hit = detectEncounter({
    agentId: "hana",
    placeId: "chamber_lena",
    placeKind: "chamber",
    activity: "wandering",
    copresent: [
      { agentId: "hana", activity: "wandering" },
      { agentId: "lena", activity: "idle" },
    ],
    cooldownExpired: () => true,
  });

  expect(hit?.colleague).toBe("lena");
  expect(hit?.encounterId).toStartWith("e-");
});
