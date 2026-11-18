import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/memory/session-store";
import { routes } from "../src/ui/features/castle/routes";

let dir: string;
beforeEach(() => { dir = join(tmpdir(), `shared-compat-${Date.now()}-${Math.random()}`); });
afterEach(() => { delete process.env.ANIMA_SHARED_CONVERSATIONS; rmSync(dir, { recursive: true, force: true }); });

test("Castle no longer claims the shared-conversation route, and direct sessions stay intact", async () => {
  // Castle talks through the agent's own real Town session (/api/talk/:agent)
  // now, not a synthetic @shared conversation. The
  // castle feature's routes() no longer recognizes this path at all.
  const store = new SessionStore(join(dir, "sessions.db"));
  const direct = store.createSession("bruno", "ui");
  store.appendTurn(direct.id, "user", "DIRECT_MARKER");

  const response = await routes(new Request("http://x/api/castle/conversation/talk", { method: "POST" }), "/api/castle/conversation/talk", { roomsDir: join(dir, "rooms") });

  expect(response).toBeNull();
  expect(store.getTurns(direct.id).map((turn) => turn.content)).toEqual(["DIRECT_MARKER"]);
  expect(() => store.createSession("@shared", "ui")).toThrow(/reserved/);
  store.close();
});

test("a shared row is a separate durable namespace, never a branch or migration of a private UI session", () => {
  const store = new SessionStore(join(dir, "sessions.db"));
  const direct = store.createSession("bruno", "ui");
  store.appendTurn(direct.id, "assistant", "PRIVATE_DIRECT_MARKER");
  const shared = store.createSharedConversation({ kind: "ambient", placeId: "garden", visibility: "colony", readerIds: ["bruno", "owner"] });

  expect(shared.sessionId).not.toBe(direct.id);
  expect(store.getTurns(direct.id)[0]?.content).toBe("PRIVATE_DIRECT_MARKER");
  expect(store.getSharedUtterances(shared.sessionId)).toEqual([]);
  store.close();
});
