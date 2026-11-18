import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/memory/session-store";
import { SessionManager } from "../../src/session/manager";

function makeStore() {
  return new SessionStore(join(tmpdir(), `test-manager-close-${Date.now()}-${Math.random()}.db`));
}

describe("SessionManager.closeSession across instances", () => {
  test("a fresh manager closes a session another manager opened and fires onEnd once", async () => {
    const store = makeStore();
    const opener = new SessionManager({ store });
    const session = opener.openSession("bruno", "ui");

    const ended: Array<[string, string]> = [];
    const closer = new SessionManager({ store, onEnd: async (id, agent) => { ended.push([id, agent]); } });
    closer.closeSession("bruno", "ui");
    await new Promise((r) => setTimeout(r, 10));

    expect(store.getSession(session.id)?.ended).toBeTruthy();
    expect(ended).toEqual([[session.id, "bruno"]]);
  });

  test("does nothing when no open session exists", async () => {
    const store = makeStore();
    let called = 0;
    const mgr = new SessionManager({ store, onEnd: async () => { called++; } });
    mgr.closeSession("bruno", "ui");
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(0);
  });

  test("does not fire onEnd for an already ended session", async () => {
    const store = makeStore();
    const opener = new SessionManager({ store });
    const session = opener.openSession("bruno", "ui");
    store.endSession(session.id);
    let called = 0;
    const mgr = new SessionManager({ store, onEnd: async () => { called++; } });
    mgr.closeSession("bruno", "ui");
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(0);
  });
});
