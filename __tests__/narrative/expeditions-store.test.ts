import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SharedNarrativeStore, __resetSharedNarrativeStore } from "../../src/narrative/shared-store";

let dir: string;
let store: SharedNarrativeStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anima-exped-"));
  __resetSharedNarrativeStore();
  store = new SharedNarrativeStore(join(dir, "memory.db"));
  store.seedPlacesFromRoster(["lena", "bruno"]);
});

// SC-001: schema
test("SC-001: fresh store has expeditions table", () => {
  expect(store.tableExists("expeditions")).toBe(true);
  const store2 = new SharedNarrativeStore(join(dir, "memory.db"));
  expect(store2.tableExists("expeditions")).toBe(true);
});

// SC-002: claim creates row + gate presence
test("SC-002: claimExpedition creates claimed row", () => {
  const res = store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.expedition.status).toBe("claimed");
  expect(res.expedition.target).toBe("machine");
  expect(res.expedition.startedAt).toBeNull();
  expect(res.expedition.discoveryRef).toBeNull();
});

// SC-003: daily ladder — second claim same day rejected
test("SC-003: second claim same day rejected with ladder", () => {
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  const second = store.claimExpedition({ id: "e-2", agentId: "lena", target: "world", now: 2000 });
  expect(second.ok).toBe(false);
  if (second.ok) return;
  expect(second.reason).toBe("ladder");
});

// SC-007: rebuild from events
test("SC-007: rebuildExpeditionsFromEvents reproduces row", () => {
  const events = [
    { type: "EXPEDITION_CLAIMED", payload: { expeditionId: "e-1", agentId: "lena", target: "machine" }, timestamp: "2026-07-12T00:00:00.000Z" },
  ];
  const fresh = new SharedNarrativeStore(join(dir, "rebuild.db"));
  fresh.rebuildExpeditionsFromEvents(events as any);
  const rebuilt = fresh.getExpedition("e-1");
  expect(rebuilt).not.toBeNull();
  expect(rebuilt).toMatchObject({ id: "e-1", agentId: "lena", target: "machine", status: "claimed" });
});

test("SC-007b: rebuildExpeditionsFromEvents folds EXPEDITION_ENDED into the row", () => {
  const events = [
    { type: "EXPEDITION_CLAIMED", payload: { expeditionId: "e-1", agentId: "lena", target: "machine" }, timestamp: "2026-07-12T00:00:00.000Z" },
    { type: "EXPEDITION_ENDED", payload: { expeditionId: "e-1", hadDiscovery: true }, timestamp: "2026-07-12T00:30:00.000Z" },
  ];
  const fresh = new SharedNarrativeStore(join(dir, "rebuild2.db"));
  fresh.rebuildExpeditionsFromEvents(events as any);
  const rebuilt = fresh.getExpedition("e-1");
  expect(rebuilt?.status).toBe("ended");
});

// start/end transitions
test("startExpedition moves claimed→running; endExpedition moves running→ended", () => {
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  expect(store.startExpedition("e-1", 2000).ok).toBe(true);
  const end = store.endExpedition("e-1", "rooms/lena/outbox/discovery-e-1.md", 3000);
  expect(end.ok).toBe(true);
  if (!end.ok) return;
  expect(end.expedition.status).toBe("ended");
  expect(end.expedition.discoveryRef).toBe("rooms/lena/outbox/discovery-e-1.md");
});

// claimedExpeditions returns oldest-first
test("claimedExpeditions returns claimed rows ordered oldest-first", () => {
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  store.claimExpedition({ id: "e-2", agentId: "bruno", target: "world", now: 2000 });
  const claimed = store.claimedExpeditions();
  expect(claimed.length).toBe(2);
  expect(claimed[0].id).toBe("e-1");
});
