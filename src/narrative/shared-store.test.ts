import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SharedNarrativeStore } from "./shared-store";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "anima-shared-store-"));
  dbPath = join(tmpDir, "memory.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── places table ──────────────────────────────────────────────────────

test("SC-001: constructing SharedNarrativeStore creates places with correct columns", () => {
  const store = new SharedNarrativeStore(dbPath);
  // Should not throw; table exists implicitly via seedPlaces/getPlace
  const place = store.getPlace("hall_main");
  expect(place).not.toBeNull();
  expect(place?.id).toBe("hall_main");
  expect(place?.kind).toBe("hall");
  expect(typeof place?.label).toBe("string");
});

test("SC-002: inserting presence with unknown place_id throws (FK)", () => {
  const store = new SharedNarrativeStore(dbPath);
  expect(() => {
    store.setPresence({
      agentId: "bruno",
      placeId: "nonexistent_place",
      since: Date.now(),
    });
  }).toThrow();
});

test("SC-003: seeding from roster produces expected place ids", () => {
  const store = new SharedNarrativeStore(dbPath);
  store.seedPlacesFromRoster(["bruno", "lena"]);
  const places = store.listPlaces().map((p) => p.id).sort();
  expect(places).toContain("chamber_bruno");
  expect(places).toContain("chamber_lena");
  expect(places).toContain("hall_main");
  expect(places).toContain("garden");
  expect(places).toContain("workshop");
  expect(places).toContain("gate_machine");
  expect(places).toContain("gate_world");
});

test("SC-004: re-opening the store does not duplicate seeded rows", () => {
  const store1 = new SharedNarrativeStore(dbPath);
  store1.seedPlacesFromRoster(["bruno", "lena"]);
  const count1 = store1.listPlaces().length;

  // Re-open with a new instance on same path
  const store2 = new SharedNarrativeStore(dbPath);
  store2.seedPlacesFromRoster(["bruno", "lena"]);
  const count2 = store2.listPlaces().length;

  expect(count2).toBe(count1);
});

test("SC-005: meta JSON round-trips through setPlace/getPlace", () => {
  const store = new SharedNarrativeStore(dbPath);
  store.seedPlacesFromRoster(["bruno"]);
  store.updatePlaceMeta("chamber_bruno", { vibe: "warm", lighting: 0.8 });
  const place = store.getPlace("chamber_bruno");
  expect(place?.meta).toEqual({ vibe: "warm", lighting: 0.8 });
});

// ── presence table ────────────────────────────────────────────────────

test("SC-008: presence table is created with FK to places", () => {
  const store = new SharedNarrativeStore(dbPath);
  store.seedPlacesFromRoster(["bruno"]);
  // Round-trip proves schema is wired
  store.setPresence({ agentId: "bruno", placeId: "chamber_bruno", since: 1000 });
  const p = store.getPresence("bruno");
  expect(p).not.toBeNull();
  expect(p?.agentId).toBe("bruno");
  expect(p?.placeId).toBe("chamber_bruno");
  expect(p?.since).toBe(1000);
});

test("SC-013: setPresence + getPresence round-trip", () => {
  const store = new SharedNarrativeStore(dbPath);
  store.seedPlacesFromRoster(["bruno"]);
  store.setPresence({
    agentId: "bruno",
    placeId: "garden",
    since: 5000,
    mood: "calm",
    activity: "wandering",
  });
  const p = store.getPresence("bruno");
  expect(p).toMatchObject({
    agentId: "bruno",
    placeId: "garden",
    since: 5000,
    mood: "calm",
    activity: "wandering",
  });
});

test("SC-014: upserting twice keeps only latest row", () => {
  const store = new SharedNarrativeStore(dbPath);
  store.seedPlacesFromRoster(["bruno"]);
  store.setPresence({ agentId: "bruno", placeId: "chamber_bruno", since: 1000 });
  store.setPresence({ agentId: "bruno", placeId: "garden", since: 2000 });
  const p = store.getPresence("bruno");
  expect(p?.placeId).toBe("garden");
  expect(p?.since).toBe(2000);
});

test("SC-015: activity 'wandering' round-trips", () => {
  const store = new SharedNarrativeStore(dbPath);
  store.seedPlacesFromRoster(["bruno"]);
  store.setPresence({
    agentId: "bruno",
    placeId: "garden",
    since: 1,
    activity: "wandering",
  });
  expect(store.getPresence("bruno")?.activity).toBe("wandering");
});

test("SC-016: activity with colons round-trips", () => {
  const store = new SharedNarrativeStore(dbPath);
  store.seedPlacesFromRoster(["bruno"]);
  store.setPresence({
    agentId: "bruno",
    placeId: "chamber_bruno",
    since: 1,
    activity: "meeting:lena",
  });
  expect(store.getPresence("bruno")?.activity).toBe("meeting:lena");
});

test("listPresence returns all agents with their places", () => {
  const store = new SharedNarrativeStore(dbPath);
  store.seedPlacesFromRoster(["bruno", "lena"]);
  store.setPresence({ agentId: "bruno", placeId: "garden", since: 1 });
  store.setPresence({ agentId: "lena", placeId: "chamber_lena", since: 2 });
  const all = store.listPresence();
  expect(all.length).toBe(2);
  const ids = all.map((p) => p.agentId).sort();
  expect(ids).toEqual(["bruno", "lena"]);
});
