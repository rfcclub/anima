import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendMeetingTurn, safeTopic, transcriptRelPath, readRecentTurns } from "./transcript";

let roomsDir: string;

beforeEach(() => {
  roomsDir = mkdtempSync(join(tmpdir(), "anima-transcript-"));
});

afterEach(() => {
  // OS cleans tmpdir
});

// SC-031: first append creates dir + header + one turn block
test("SC-031: first append creates header + one turn block", async () => {
  const rel = await appendMeetingTurn({
    roomsDir,
    topic: "blocker-sync",
    agentName: "bruno",
    content: "let's unblock the deploy",
    now: new Date("2026-07-12T10:00:00Z"),
  });
  const path = join(roomsDir, rel);
  expect(existsSync(path)).toBe(true);
  const body = readFileSync(path, "utf8");
  expect(body).toContain("# Meeting: blocker-sync");
  expect(body).toContain("**bruno** —");
  expect(body).toContain("let's unblock the deploy");
});

// SC-032: second append: both turns, one header
test("SC-032: second append keeps one header + two turns", async () => {
  const now1 = new Date("2026-07-12T10:00:00Z");
  const now2 = new Date("2026-07-12T10:01:00Z");
  await appendMeetingTurn({ roomsDir, topic: "blocker-sync", agentName: "bruno", content: "first", now: now1 });
  await appendMeetingTurn({ roomsDir, topic: "blocker-sync", agentName: "lena", content: "second", now: now2 });
  const rel = transcriptRelPath("blocker-sync", now1);
  const body = readFileSync(join(roomsDir, rel), "utf8");
  const headerCount = (body.match(/# Meeting:/g) ?? []).length;
  expect(headerCount).toBe(1);
  expect(body).toContain("first");
  expect(body).toContain("second");
});

// SC-033: slug from topic
test("SC-033: 'Blocker Sync!!' → 'blocker-sync' dir", () => {
  expect(safeTopic("Blocker Sync!!")).toBe("blocker-sync");
});

// SC-034: empty slug throws
test("SC-034: '!!!' throws empty slug", () => {
  expect(() => safeTopic("!!!")).toThrow();
});

// SC-035: two concurrent appends both land
test("SC-035: two concurrent appends both land", async () => {
  const now = new Date("2026-07-12T10:00:00Z");
  await Promise.all([
    appendMeetingTurn({ roomsDir, topic: "sync", agentName: "bruno", content: "from-bruno", now }),
    appendMeetingTurn({ roomsDir, topic: "sync", agentName: "lena", content: "from-lena", now }),
  ]);
  const rel = transcriptRelPath("sync", now);
  const body = readFileSync(join(roomsDir, rel), "utf8");
  expect(body).toContain("from-bruno");
  expect(body).toContain("from-lena");
});

// readRecentTurns: returns last N turn texts
test("readRecentTurns returns clipped tail for attending context", async () => {
  const now = new Date("2026-07-12T10:00:00Z");
  for (let i = 0; i < 5; i++) {
    await appendMeetingTurn({ roomsDir, topic: "tail", agentName: "bruno", content: `turn-${i}`, now: new Date(now.getTime() + i * 60000) });
  }
  const tail = readRecentTurns(roomsDir, "tail", 3);
  expect(tail.length).toBeLessThanOrEqual(3);
  expect(tail[tail.length - 1]).toContain("turn-4");
});
