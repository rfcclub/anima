import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/memory/session-store";
import { closeOpenSessions } from "../../src/session/close-open-sessions";

function makeStore() {
  return new SessionStore(join(tmpdir(), `test-close-open-${Date.now()}-${Math.random()}.db`));
}

describe("closeOpenSessions", () => {
  test("ends each listed agent's open session on the channel, skips agents with none", async () => {
    const store = makeStore();
    const a = store.createSession("bruno", "ui");
    const b = store.createSession("eli", "ui");
    const other = store.createSession("bruno", "talk");

    const ended: string[] = [];
    const result = closeOpenSessions({
      store,
      agents: ["bruno", "eli", "jade"],
      channel: "ui",
      onEnd: async (_id, agent) => { ended.push(agent); },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(result.closed.sort()).toEqual(["bruno", "eli"]);
    expect(result.failed).toEqual([]);
    expect(store.getSession(a.id)?.ended).toBeTruthy();
    expect(store.getSession(b.id)?.ended).toBeTruthy();
    expect(store.getSession(other.id)?.ended).toBeFalsy();
    expect(ended.sort()).toEqual(["bruno", "eli"]);
  });

  test("keeps closing the others when one agent's close throws", () => {
    const store = makeStore();
    store.createSession("bruno", "ui");
    store.createSession("eli", "ui");
    const realEnd = store.endSession.bind(store);
    store.endSession = (id: string) => {
      if (store.getSession(id)?.agent === "bruno") throw new Error("boom");
      realEnd(id);
    };

    const result = closeOpenSessions({ store, agents: ["bruno", "eli"], channel: "ui" });

    expect(result.closed).toEqual(["eli"]);
    expect(result.failed).toEqual([{ agent: "bruno", error: "boom" }]);
  });
});

describe("resolveSessionStore", () => {
  test("returns the first store that holds the session, or undefined", async () => {
    const { resolveSessionStore } = await import("../../src/session/close-open-sessions");
    const a = makeStore();
    const b = makeStore();
    const inB = b.createSession("bruno", "ui");
    expect(resolveSessionStore(inB.id, [a, b])).toBe(b);
    expect(resolveSessionStore("missing", [a, b])).toBeUndefined();
  });
});

describe("closeOpenSessions end-handler behaviour", () => {
  test("runs onEnd one at a time, not all at once", async () => {
    const store = makeStore();
    for (const a of ["bruno", "eli", "jade"]) store.createSession(a, "ui");
    let running = 0;
    let maxRunning = 0;
    const done: string[] = [];

    closeOpenSessions({
      store,
      agents: ["bruno", "eli", "jade"],
      channel: "ui",
      onEnd: async (_id, agent) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 15));
        running--;
        done.push(agent);
      },
    });
    await new Promise((r) => setTimeout(r, 120));

    expect(done.sort()).toEqual(["bruno", "eli", "jade"]);
    expect(maxRunning).toBe(1);
  });

  test("a failing onEnd does not stop the next one", async () => {
    const store = makeStore();
    for (const a of ["bruno", "eli"]) store.createSession(a, "ui");
    const done: string[] = [];
    closeOpenSessions({
      store,
      agents: ["bruno", "eli"],
      channel: "ui",
      onEnd: async (_id, agent) => {
        if (agent === "bruno") throw new Error("model down");
        done.push(agent);
      },
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(done).toEqual(["eli"]);
  });

  test("reports endHandlerMissing when no onEnd is given", () => {
    const store = makeStore();
    store.createSession("bruno", "ui");
    expect(closeOpenSessions({ store, agents: ["bruno"], channel: "ui" }).endHandlerMissing).toBe(true);
    store.createSession("eli", "ui");
    expect(closeOpenSessions({ store, agents: ["eli"], channel: "ui", onEnd: async () => {} }).endHandlerMissing).toBe(false);
  });
});
