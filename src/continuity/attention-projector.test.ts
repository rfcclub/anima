import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GardenEvent } from "../garden/events";
import { ActivationStore } from "./activation-store";
import { rebuildAttentionFromEvents } from "./attention-projector";

function opened(): GardenEvent {
  return {
    id: "attention-open-1", type: "ATTENTION_OPENED", timestamp: "1970-01-01T00:00:01.000Z",
    agentId: "eli", instanceId: "test", runtime: "test", project: "castle",
    payload: {
      sourceKind: "mesh", sourceRef: "mesh:42", occurrenceKey: "mesh:42", kind: "request",
      urgency: 5, summary: "review this", openedAt: 1_000, dueAt: 1_000,
      state: "open", version: 1, occurredAt: 1_000,
    },
  };
}

test("SC-013: replaying attention events rebuilds the same terminal lifecycle", () => {
  const dir = mkdtempSync(join(tmpdir(), "attention-projector-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  try {
    const result = rebuildAttentionFromEvents(store, [
      opened(),
      {
        ...opened(), id: "attention-claimed-1", type: "ATTENTION_STATE_CHANGED", timestamp: "1970-01-01T00:00:02.000Z",
        payload: { ...opened().payload as object, state: "claimed", version: 2, occurredAt: 2_000 },
      },
      {
        ...opened(), id: "attention-acted-1", type: "ATTENTION_STATE_CHANGED", timestamp: "1970-01-01T00:00:03.000Z",
        payload: { ...opened().payload as object, state: "acted", version: 3, occurredAt: 3_000 },
      },
      {
        ...opened(), id: "attention-resolved-1", type: "ATTENTION_STATE_CHANGED", timestamp: "1970-01-01T00:00:04.000Z",
        payload: { ...opened().payload as object, state: "resolved", version: 4, occurredAt: 4_000 },
      },
    ]);
    expect(result).toEqual({ projected: 1, transitioned: 3, ignored: 0 });
    expect(store.openAttention("eli")).toEqual([]);
    expect(store.getAttentionByOccurrence("eli", "mesh", "mesh:42", "mesh:42")?.state).toBe("resolved");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
