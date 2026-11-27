import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/memory/session-store";
import { resetAfterDream } from "../../src/session/reset-after-dream";
import { loadRoomConfig } from "../../src/config/types";

function makeStore() {
  return new SessionStore(join(tmpdir(), `test-reset-dream-${Date.now()}-${Math.random()}.db`));
}

const LATER = () => Date.now() + 60 * 60 * 1000;

function roomConfig(extra = ""): ReturnType<typeof loadRoomConfig> {
  return loadRoomConfig(`
identity:
  name: bruno
  label: Bruno
provider:
  type: openai
policy:
  allowedRoots: ["/tmp"]
session:
  defaultMode: plan
${extra}
boot:
  gene: /tmp/gene.md
  sessionContext:
    - /tmp/context.md
`);
}

describe("resetAfterDream", () => {
  test("defaults: the reset is on and the idle threshold is 30 minutes", async () => {
    const store = makeStore();
    const session = store.createSession("bruno", "ui");
    store.appendTurn(session.id, "user", "hello");

    const result = await resetAfterDream({
      store,
      agents: ["bruno"],
      readConfig: async () => roomConfig(),
      now: LATER,
      onEnd: async () => {},
    });

    expect(result.reset).toEqual(["bruno"]);
    expect(store.getSession(session.id)?.ended).toBeTruthy();
  });

  test("an agent that opts out is left alone", async () => {
    const store = makeStore();
    const session = store.createSession("bruno", "ui");
    store.appendTurn(session.id, "user", "hello");

    const result = await resetAfterDream({
      store,
      agents: ["bruno"],
      readConfig: async () => roomConfig("  resetAfterDream: false"),
      now: LATER,
      onEnd: async () => {},
    });

    expect(result.reset).toEqual([]);
    expect(store.getSession(session.id)?.ended).toBeFalsy();
  });

  test("the configured idle threshold decides whether a session is cut", async () => {
    const store = makeStore();
    const idle = store.createSession("bruno", "ui");
    const recent = store.createSession("eli", "ui");
    store.appendTurn(idle.id, "user", "hello");
    store.appendTurn(recent.id, "user", "hello");

    // Only one minute of slack: an idleMs of a day leaves both alone.
    const result = await resetAfterDream({
      store,
      agents: ["bruno", "eli"],
      readConfig: async (agent) =>
        roomConfig(agent === "bruno" ? "  resetIdleMs: 86400000" : "  resetIdleMs: 1000"),
      now: () => Date.now() + 60 * 60 * 1000,
      onEnd: async () => {},
    });

    expect(result.reset).toEqual(["eli"]);
    expect(store.getSession(idle.id)?.ended).toBeFalsy();
    expect(store.getSession(recent.id)?.ended).toBeTruthy();
  });

  test("an unreadable config fails that agent only", async () => {
    const store = makeStore();
    const session = store.createSession("eli", "ui");
    store.appendTurn(session.id, "user", "hello");

    const result = await resetAfterDream({
      store,
      agents: ["bruno", "eli"],
      readConfig: async (agent) => {
        if (agent === "bruno") throw new Error("bad yaml");
        return roomConfig();
      },
      now: LATER,
      onEnd: async () => {},
    });

    expect(result.failed).toEqual([{ agent: "bruno", error: "bad yaml" }]);
    expect(result.reset).toEqual(["eli"]);
  });
});
