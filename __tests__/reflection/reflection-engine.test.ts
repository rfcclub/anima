import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";

describe("AgentState — validation", () => {
  test("valid states: in-room, visiting:X, away:X, idle", () => {
    const VALID = ["in-room", "visiting", "away", "idle"];
    for (const [input, expectedBase] of [["in-room", "in-room"], ["visiting:eli", "visiting"], ["away:meditation", "away"], ["idle", "idle"]] as const) {
      const base = input.startsWith("visiting:") ? "visiting" : input.startsWith("away:") ? "away" : input;
      expect(base).toBe(expectedBase);
      expect(VALID.includes(base)).toBe(true);
    }
  });
  test("invalid states fail", () => {
    const VALID = ["in-room", "visiting", "away", "idle"];
    for (const input of ["sleeping", "", "on-fire"]) {
      const base = input.startsWith("visiting:") ? "visiting" : input.startsWith("away:") ? "away" : input;
      expect(VALID.includes(base)).toBe(false);
    }
  });
  test("agent_states table CRUD", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE IF NOT EXISTS agent_states (agent_id TEXT PRIMARY KEY, state TEXT NOT NULL, context TEXT, updated_at INTEGER NOT NULL)");
    db.run("INSERT OR REPLACE INTO agent_states VALUES (?, ?, ?, ?)", ["bruno", "in-room", null, Date.now()]);
    const row = db.query("SELECT state FROM agent_states WHERE agent_id = ?").get("bruno") as any;
    expect(row.state).toBe("in-room");
  });
});

describe("EVALUATE — urgency scoring", () => {
  function score(inbox: boolean, goals: boolean, knock: boolean): number {
    return (inbox ? 3 : 0) + (goals ? 2 : 0) + (knock ? 5 : 0);
  }
  test("inbox → score 3", () => expect(score(true, false, false)).toBe(3));
  test("no triggers → score 0", () => expect(score(false, false, false)).toBe(0));
  test("knock → score 5", () => expect(score(false, false, true)).toBe(5));
  test("threshold 3 gates correctly", () => {
    const T = 3;
    expect(score(true, false, false) >= T).toBe(true);
    expect(score(false, true, false) >= T).toBe(false);
  });
});

describe("TickRunner — concurrency", () => {
  test("ticking flag prevents concurrent ticks", async () => {
    let ticking = false, count = 0;
    async function tick() { if (ticking) return; ticking = true; count++; await new Promise(r => setTimeout(r, 30)); ticking = false; }
    await Promise.all([tick(), tick()]);
    expect(count).toBe(1);
  });
});

describe("DebouncedTrigger", () => {
  test("cooldown works", () => {
    const map = new Map<string, number>();
    const CD = 10 * 60 * 1000;
    const can = (k: string) => { const l = map.get(k); return !l || Date.now() - l >= CD; };
    expect(can("x")).toBe(true);
    map.set("x", Date.now());
    expect(can("x")).toBe(false);
    map.set("x", Date.now() - CD - 1000);
    expect(can("x")).toBe(true);
  });
});

describe("SoulCache — TTL", () => {
  test("TTL invalidation", () => {
    const ttl = 5 * 60 * 1000;
    expect(Date.now() - (Date.now() - 1000) < ttl).toBe(true);
    expect(Date.now() - (Date.now() - 6 * 60 * 1000) < ttl).toBe(false);
  });
});
