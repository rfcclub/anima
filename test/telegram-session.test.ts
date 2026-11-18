import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramMeetingSession, TelegramSessionStore } from "../src/channels/telegram-session";
import { SessionStore } from "../src/memory/session-store";
import { createSessionFixture } from "./fixtures/telegram-session-context";
let root: string;
let fixtures: ReturnType<typeof createSessionFixture>[];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "telegram-session-fixture-")); fixtures = []; });
afterEach(async () => {
  try { for (const fixture of fixtures) await fixture.session.end(); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
function makeSession(chat: string, refuseInbound = false) {
  const fixture = createSessionFixture(chat, root, refuseInbound); fixtures.push(fixture); return fixture.session;
}


test("session starts with no participants", () => {
  const s = makeSession("tg-100");
  expect(s.participants.size).toBe(0);
  expect(s.chatId).toBe("tg-100");
});

test("@mention joins agent to session", async () => {
  const s = makeSession("tg-101");
  const result = await s.process("@bruno hello");
  expect(s.participants.has("bruno")).toBe(true);
  expect(fixtures[0].opened).toEqual(["bruno"]);
  expect(fixtures[0].inbound[0]?.text).toBe("@bruno hello");
});

test("@all observes all current participants", async () => {
  const s = makeSession("tg-102");
  s.participants.add("bruno");
  s.participants.add("eli");
  const result = await s.process("@all listen up");
  expect(result.reply).toContain("noted");
  expect(fixtures[0].observed.map((entry) => entry.agent)).toEqual(["bruno", "eli"]);
});

test("/who returns participants list", async () => {
  const s = makeSession("tg-103");
  s.participants.add("bruno");
  s.participants.add("eli");
  const result = await s.process("/who");
  expect(result.reply).toContain("bruno");
  expect(result.reply).toContain("eli");
});

test("/end clears session and participants", async () => {
  const s = makeSession("tg-104");
  s.participants.add("bruno");
  const result = await s.process("/end");
  expect(result.reply).toBe("session ended");
  expect(s.participants.size).toBe(0);
  expect(fixtures[0].closed).toEqual(["bruno"]);
});

test("/leave removes agent from participants", async () => {
  const s = makeSession("tg-105");
  s.participants.add("bruno");
  s.participants.add("eli");
  const result = await s.process("/leave @bruno");
  expect(result.reply).toBe("bruno left the session");
  expect(s.participants.has("bruno")).toBe(false);
  expect(s.participants.has("eli")).toBe(true);
  expect(fixtures[0].closed).toEqual(["bruno"]);
});

test("/leave with unknown agent", async () => {
  const s = makeSession("tg-106");
  const result = await s.process("/leave @bruno");
  expect(result.reply).toContain("is not in session");
});

test("no mention with participants returns observation", async () => {
  const s = makeSession("tg-107", true);
  s.participants.add("bruno");
  const result = await s.process("just talking");
  // observation: no reply, agents listed in observed
  expect(result.reply).toBeNull();
  expect(result.observed).toContain("bruno");
});

test.skip("telegram observations append user turns to SessionStore", async () => {
  // Requires an agent provider to be available
  const dir = join(tmpdir(), `anima-telegram-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const sessionStore = new SessionStore(join(dir, "sessions.db"));
  const s = new TelegramMeetingSession("tg-store", { sessionStore });
  s.participants.add("bruno");

  await s.process("just talking");

  const session = sessionStore.getLatestSession("bruno", "tg-store");
  expect(session).not.toBeNull();
  const turns = sessionStore.getTurns(session!.id);
  expect(turns).toHaveLength(1);
  expect(turns[0].role).toBe("user");
  expect(turns[0].content).toBe("just talking");
  sessionStore.close();
});

test("no mention without participants returns nothing", async () => {
  const s = makeSession("tg-108");
  const result = await s.process("talking to nobody");
  expect(result.reply).toBeNull();
  expect(result.observed).toEqual([]);
});

test("@agent1+agent2+agent3 joins all and first responds", async () => {
  const s = makeSession("tg-109");
  const result = await s.process("@bruno+eli+milo team check");
  expect(s.participants.has("bruno")).toBe(true);
  expect(s.participants.has("eli")).toBe(true);
  expect(s.participants.has("milo")).toBe(true);
  expect(result.reply).toBe("fixture response");
  expect(fixtures[0].opened).toEqual(["bruno", "eli", "milo"]);
  expect(fixtures[0].inbound).toHaveLength(1);
  expect(fixtures[0].observed.map((entry) => entry.agent)).toEqual(["eli", "milo"]);
});

test("/who with empty participants", async () => {
  const s = makeSession("tg-110");
  const result = await s.process("/who");
  expect(result.reply).toBe("no agents in session");
});

test("/colony returns colony overview", async () => {
  const s = makeSession("tg-200");
  const result = await s.process("/colony");
  expect(result.reply).not.toBeNull();
  expect(result.reply!).toInclude("Colony");
  expect(result.reply!).toInclude("agents");
  expect(result.reply!).toInclude("bruno");
});

test("/colony shows trust scores for known agents", async () => {
  const s = makeSession("tg-201");
  const result = await s.process("/colony");
  expect(result.reply!).toInclude("code_review");
  // Trust scores may decay from initial 0.50 — check for decimal format
  expect(result.reply!).toMatch(/\d+\.\d+/);
});

test("default help includes /colony and /review", async () => {
  const s = makeSession("tg-202");
  const result = await s.process("/unknown");
  expect(result.reply).toInclude("/colony");
  expect(result.reply).toInclude("/review");
  expect(result.reply).toInclude("/approve");
  expect(result.reply).toInclude("/reject");
});

test("regression: default construction retains stores; injected ports route without opening them", () => {
  for (const mode of ["default", "lifecycle-only", "channel-only", "injected"]) {
    const home = mkdtempSync(join(root, "construction-"));
    try {
      const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/telegram-session-construction.ts"), home, mode], {
        env: { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir(), HOME: home, ANIMA_HOME: join(home, ".anima"), ANIMA_COST_DB: ":memory:", TZ: "UTC", NODE_ENV: "test" },
        stdout: "pipe", stderr: "pipe", timeout: 10000,
      });
      expect(child.exitCode).toBe(0);
      const result = JSON.parse(new TextDecoder().decode(child.stdout));
      expect(result).toEqual(mode === "injected"
        ? { reply: "fixture response", defaultDbCreated: false, inboundCalls: 1 }
        : { reply: "no agents in session", defaultDbCreated: true, inboundCalls: 0 });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

test("default agent joins once and successful subsequent messages route to the first participant", async () => {
  const fixture = createSessionFixture("tg-default", root, false, "bruno"); fixtures.push(fixture);
  expect((await fixture.session.process("hello")).reply).toBe("fixture response");
  expect((await fixture.session.process("next")).reply).toBe("fixture response");
  expect([...fixture.session.participants]).toEqual(["bruno"]);
  expect(fixture.opened).toEqual(["bruno"]);
  expect(fixture.inbound.map((entry) => entry.text)).toEqual(["@bruno hello", "@bruno next"]);
});

test("forbidden fixture root is refused before session imports or default DB writes", () => {
  const actualHome = mkdtempSync(join(root, "actual-home-"));
  const otherRoot = mkdtempSync(join(root, "other-root-"));
  for (const [argument, animaHome] of [
    [otherRoot, join(actualHome, ".anima")],
    [actualHome, join(otherRoot, ".anima")],
    ["relative-root", join(actualHome, ".anima")],
  ]) {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/telegram-session-construction.ts"), argument, "default"], {
      env: { PATH: process.env.PATH ?? "", HOME: actualHome, ANIMA_HOME: animaHome, ANIMA_COST_DB: ":memory:", NODE_ENV: "test" },
      stdout: "pipe", stderr: "pipe", timeout: 10000,
    });
    expect(child.exitCode).toBe(1);
    expect(new TextDecoder().decode(child.stderr)).toContain("fixture root forbidden before imports");
    expect(new TextDecoder().decode(child.stdout)).toBe("");
    expect(existsSync(join(actualHome, ".anima/sessions.db"))).toBe(false);
    expect(existsSync(join(otherRoot, ".anima/sessions.db"))).toBe(false);
  }
});
