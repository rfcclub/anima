import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/memory/session-store";
import { SessionManager } from "../../src/session/manager";
import { resetIdleSessions, isResettableChannel, DEFAULT_RESET_IDLE_MS } from "../../src/session/reset-idle-sessions";

function makeStore() {
  return new SessionStore(join(tmpdir(), `test-reset-idle-${Date.now()}-${Math.random()}.db`));
}

/** One hour past now: every turn written by this test is already idle. */
const LATER = () => Date.now() + 60 * 60 * 1000;

describe("resetIdleSessions", () => {
  test("ends an idle conversational session, runs the handoff turn first, then onEnd once", async () => {
    const store = makeStore();
    const session = store.createSession("bruno", "ui");
    store.appendTurn(session.id, "user", "hello");

    const calls: string[] = [];
    const result = await resetIdleSessions({
      store,
      agents: ["bruno"],
      now: LATER,
      handoff: async (agent, s) => { calls.push(`handoff:${agent}:${s.id}`); },
      onEnd: async (id) => { calls.push(`end:${id}`); },
    });

    expect(calls).toEqual([`handoff:bruno:${session.id}`, `end:${session.id}`]);
    expect(result.reset).toEqual(["bruno"]);
    expect(store.getSession(session.id)?.ended).toBeTruthy();
  });

  test("a failed handoff turn does not stop the reset and is reported", async () => {
    const store = makeStore();
    const session = store.createSession("bruno", "ui");
    store.appendTurn(session.id, "user", "hello");
    const warnings: string[] = [];

    const result = await resetIdleSessions({
      store,
      agents: ["bruno"],
      now: LATER,
      handoff: async () => { throw new Error("provider down"); },
      onEnd: async () => {},
      log: (level, msg) => warnings.push(`${level}:${msg}`),
    });

    expect(result.handoffMissing).toEqual(["bruno"]);
    expect(result.reset).toEqual(["bruno"]);
    expect(store.getSession(session.id)?.ended).toBeTruthy();
    expect(warnings.some((w) => w.startsWith("warn:"))).toBe(true);
  });

  test("a session with a turn newer than the idle threshold is untouched", async () => {
    const store = makeStore();
    const session = store.createSession("bruno", "ui");
    store.appendTurn(session.id, "user", "still talking");

    let handoffRan = false;
    const result = await resetIdleSessions({
      store,
      agents: ["bruno"],
      handoff: async () => { handoffRan = true; },
      onEnd: async () => {},
    });

    expect(result.skipped).toEqual(["bruno"]);
    expect(result.reset).toEqual([]);
    expect(handoffRan).toBe(false);
    expect(store.getSession(session.id)?.ended).toBeFalsy();
  });

  test("the per-agent opt-out is respected", async () => {
    const store = makeStore();
    const session = store.createSession("bruno", "ui");
    store.appendTurn(session.id, "user", "hello");

    const result = await resetIdleSessions({
      store,
      agents: ["bruno"],
      now: LATER,
      shouldReset: () => false,
      onEnd: async () => {},
    });

    expect(result.reset).toEqual([]);
    expect(store.getSession(session.id)?.ended).toBeFalsy();
  });

  test("an onEnd failure does not block ending the session or the remaining ones", async () => {
    const store = makeStore();
    const bruno = store.createSession("bruno", "ui");
    const eli = store.createSession("eli", "talk");
    store.appendTurn(bruno.id, "user", "hello");
    store.appendTurn(eli.id, "user", "hi");

    const ended: string[] = [];
    const result = await resetIdleSessions({
      store,
      agents: ["bruno", "eli"],
      now: LATER,
      onEnd: async (id, agent) => {
        if (agent === "bruno") throw new Error("model down");
        ended.push(agent);
      },
    });

    expect(ended).toEqual(["eli"]);
    expect(result.reset.sort()).toEqual(["bruno", "eli"]);
    expect(store.getSession(bruno.id)?.ended).toBeTruthy();
    expect(store.getSession(eli.id)?.ended).toBeTruthy();
  });

  test("only conversational channels are reset", async () => {
    const store = makeStore();
    const review = store.createSession("bruno", "review");
    store.appendTurn(review.id, "user", "review work");

    const result = await resetIdleSessions({ store, agents: ["bruno"], now: LATER, onEnd: async () => {} });

    expect(result.reset).toEqual([]);
    expect(store.getSession(review.id)?.ended).toBeFalsy();
  });

  test("the next openSession creates a fresh session", async () => {
    const store = makeStore();
    const manager = new SessionManager({ store });
    const first = manager.openSession("bruno", "ui");
    store.appendTurn(first.id, "user", "hello");

    await resetIdleSessions({ store, agents: ["bruno"], now: LATER, onEnd: async () => {} });

    const next = manager.openSession("bruno", "ui");
    expect(next.id).not.toBe(first.id);
    expect(next.ended).toBeNull();
  });

  test("channel and threshold defaults", () => {
    expect(isResettableChannel("talk")).toBe(true);
    expect(isResettableChannel("ui")).toBe(true);
    expect(isResettableChannel("ambient:plaza")).toBe(true);
    expect(isResettableChannel("mesh")).toBe(false);
    expect(isResettableChannel("review")).toBe(false);
    expect(DEFAULT_RESET_IDLE_MS).toBe(30 * 60 * 1000);
  });
});
