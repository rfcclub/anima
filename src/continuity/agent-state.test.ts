import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SharedNarrativeStore, getSharedNarrativeStore, __resetSharedNarrativeStore } from "../narrative/shared-store";
import { AgentState } from "./agent-state";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "anima-agent-state-"));
  __resetSharedNarrativeStore();
  const store = getSharedNarrativeStore(join(tmpDir, "memory.db"));
  store.seedPlacesFromRoster(["bruno", "lena"]);
});

afterEach(() => {
  __resetSharedNarrativeStore();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("SC-010: AgentState.get returns in-room when presence is idle in a chamber", () => {
  const store = getSharedNarrativeStore();
  store.setPresence({ agentId: "bruno", placeId: "chamber_bruno", since: 1, activity: "idle" });
  expect(AgentState.get("bruno")).toBe("in-room");
});

test("SC-010b: AgentState.get returns in-room when presence is idle in hall_main", () => {
  const store = getSharedNarrativeStore();
  store.setPresence({ agentId: "bruno", placeId: "hall_main", since: 1, activity: "idle" });
  expect(AgentState.get("bruno")).toBe("in-room");
});

test("SC-011: AgentState.get returns away:garden when activity is wandering and place is garden", () => {
  const store = getSharedNarrativeStore();
  store.setPresence({ agentId: "bruno", placeId: "garden", since: 1, activity: "wandering" });
  expect(AgentState.get("bruno")).toBe("away:garden");
});

test("SC-012: AgentState.get returns null when no presence row exists", () => {
  expect(AgentState.get("bruno")).toBeNull();
});

test("SC-014: AgentState.set then AgentState.get reflects the change via presence upsert", () => {
  AgentState.set("bruno", "in-room");
  expect(AgentState.get("bruno")).toBe("in-room");

  AgentState.set("bruno", "away:garden");
  expect(AgentState.get("bruno")).toBe("away:garden");

  AgentState.set("bruno", "visiting:lena");
  expect(AgentState.get("bruno")).toBe("visiting:lena");
});

test("AgentState.set writes through to presence table", () => {
  AgentState.set("bruno", "away:garden");
  const store = getSharedNarrativeStore();
  const p = store.getPresence("bruno");
  expect(p).not.toBeNull();
  expect(p?.placeId).toBe("garden");
  expect(p?.activity).toBe("wandering");
});

test("AgentState.set with visiting writes meeting activity", () => {
  AgentState.set("bruno", "visiting:lena");
  const store = getSharedNarrativeStore();
  const p = store.getPresence("bruno");
  expect(p?.activity).toBe("meeting:lena");
  expect(p?.placeId).toBe("chamber_lena");
});

test("AgentState.set away:expedition maps to gate_world", () => {
  AgentState.set("bruno", "away:expedition");
  const store = getSharedNarrativeStore();
  const p = store.getPresence("bruno");
  expect(p?.placeId).toBe("gate_world");
  expect(p?.activity).toBe("wandering");
});

test("AgentState.set away:workshop maps to workshop place", () => {
  AgentState.set("bruno", "away:workshop");
  const store = getSharedNarrativeStore();
  const p = store.getPresence("bruno");
  expect(p?.placeId).toBe("workshop");
});

test("AgentState.getAll reflects state written via AgentState.set", () => {
  AgentState.set("bruno", "in-room");
  const all = AgentState.getAll();
  expect(all.length).toBeGreaterThanOrEqual(1);
  const bruno = all.find((r) => r.agentId === "bruno");
  expect(bruno?.state).toBe("in-room");
});

test("AgentState.getAll reflects presence written directly to the shared store, bypassing AgentState.set", () => {
  // Regression test: reflection-engine, castle routes, and expedition-dispatcher
  // all call store.setPresence() directly rather than going through AgentState.set().
  // getAll() must see those writes too, not just ones made through AgentState.set().
  const store = getSharedNarrativeStore();
  store.setPresence({ agentId: "lena", placeId: "garden", since: Date.now(), activity: "wandering" });

  const all = AgentState.getAll();
  const lena = all.find((r) => r.agentId === "lena");
  expect(lena?.state).toBe("away:garden");
});
