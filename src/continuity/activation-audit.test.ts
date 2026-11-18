import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlGardenEventStore } from "../garden/event-store";
import { GardenActivationAudit } from "./activation-audit";
import { ActivationBroker } from "./activation-broker";
import { buildCandidate } from "./activation-candidate";

test("SC-055 appends one suppression event per candidate/reason window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-audit-"));
  const events = new JsonlGardenEventStore(join(dir, "events.jsonl"));
  try {
    const audit = new GardenActivationAudit(events, { instanceId: "test", runtime: "test", project: "castle" });
    const broker = new ActivationBroker({ armTimer: () => {}, onSuppressed: (event) => audit.appendSuppressed(event) });
    const candidate = buildCandidate({ agentId: "eli", sourceKind: "mesh", sourceRef: "mesh:1", occurrenceKey: "mesh:1", sourceVersion: 1, dueAt: 1, urgency: 1, costClass: "T1", executor: "reflection", summary: "request", reasonRef: "mesh:1" });
    expect(await broker.recordSuppression(candidate, "budget", 100, 1_000)).toBe(true);
    expect(await broker.recordSuppression(candidate, "budget", 101, 1_000)).toBe(false);
    const written = await events.readByType("ACTIVATION_SUPPRESSED");
    expect(written).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
