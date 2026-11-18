import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/memory/session-store";
import { ConversationService } from "../src/conversation/service";
import { createSharedRoomReader, readExternalSharedRoom } from "../src/identity-runtime/shared-room-read";
import { AnimaContinuityService } from "../src/identity-runtime/continuity-service";
import { ProjectionGrantStore } from "../src/identity-runtime/projection-grant-store";
import { handleTenantContinuityRequest } from "../src/api/identity-runtime/handlers";
import { HttpAnimaTenantContinuityClient } from "../packages/identity-runtime/src/anima-continuity-client";
import { TenantIdentityRuntime } from "../packages/identity-runtime/src/tenant-runtime";
import { startTenantIdentityRuntimeHttp } from "../packages/identity-runtime/src/tenant-http";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "anima-room-read-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SessionStore(join(root, "sessions.db"));
  cleanups.push(() => store.close());
  let occupants = ["eli"];
  const authority = new ConversationService({
    store, operatorId: "owner", resolvePlace: placeId => ({ placeId, occupants, visibility: "members" }),
    isKnownColonyPrincipal: id => ["eli", "bruno"].includes(id),
  });
  const room = authority.getOrCreateAmbientForSpeech("chamber_eli").conversation;
  store.appendSharedUtterance({
    conversationId: room.sessionId, speakerId: "eli", role: "assistant",
    content: "AUTHORIZED_ROOM_MARKER", utteranceKey: "turn", requestId: "request", source: "ui",
  });
  let reads = 0, enabled = true;
  let now = 100;
  const getUtterances = store.getSharedUtterances.bind(store);
  store.getSharedUtterances = id => { reads++; return getUtterances(id); };
  const reader = createSharedRoomReader({ store, conversationService: authority, enabled: () => enabled });
  const services = new Map<string, AnimaContinuityService>();
  for (const identity of ["eli", "bruno"]) {
    const grants = new ProjectionGrantStore(join(root, `${identity}.db`));
    cleanups.push(() => grants.close());
    services.set(identity, new AnimaContinuityService({
      identity, grantStore: grants, now: () => now,
      canonicalStateHash: () => `${identity}-state`,
      compileProjection: async () => ({
        prompt: `PRIVATE_${identity}`, promptStaticHash: "hash", kernelVersion: "kernel",
        cartridgeVersions: {}, substrateViewVersion: "view", readScopes: [], writeScopes: [],
        proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "none",
      }),
      remember: async () => { throw Error("unexpected write"); }, recall: async () => [],
      readRoom: reader,
    }));
  }
  const runtime = new TenantIdentityRuntime({
    dbPath: join(root, "runtime.db"), now: () => now, log: () => {},
    tenants: new Map(["eli", "bruno"].map(id => [id, {
      continuity: new HttpAnimaTenantContinuityClient("http://anima.test", id,
        (input, init) => handleTenantContinuityRequest(new Request(input, init), agent => services.get(agent))),
    }])),
  });
  cleanups.push(() => runtime.close());
  const server = startTenantIdentityRuntimeHttp(runtime, "127.0.0.1", 0);
  cleanups.push(() => server.stop(true));
  const origin = `http://127.0.0.1:${server.port}`;
  async function post(path: string, body: unknown) {
    return fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  async function lease(agent: string) {
    return (await (await post(`/identity-runtime/${agent}/join`, { clientId: "pi-soffio", surfaceId: `pi-${agent}`, message: "join" })).json()) as Record<string, any>;
  }
  const eli = await lease("eli"), bruno = await lease("bruno");
  const request = (identity = eli) => ({
    leaseId: identity.leaseId, sessionToken: identity.sessionToken, stateHash: identity.stateHash,
    clientId: "pi-soffio", placeId: "chamber_eli", conversationId: room.sessionId,
  });
  const read = (body = request()) => post("/identity-runtime/shared/read-room", body);
  return { read, request, eli, bruno, room, store, authority, services,
    reads: () => reads, disable: () => { enabled = false; }, expire: () => { now = 10_000_000; },
    changeAudience: () => { occupants = ["bruno"]; } };
}

// @spec Authenticated room read SHALL preserve canonical authority / Leased reader gets attributed history
test("room HTTP read returns only canonical attributed history for its leased principal", async () => {
  const f = await fixture(), response = await f.read();
  expect(response.status).toBe(200);
  const result = await response.json() as any;
  expect(result.conversationId).toBe(f.room.sessionId);
  expect(JSON.parse(result.historyBlockJson)).toEqual([{ turnId: 1, speakerId: "eli", content: "AUTHORIZED_ROOM_MARKER" }]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_eli");
  expect(JSON.stringify(result)).not.toContain(f.eli.sessionToken);
  expect(f.reads()).toBe(1);
  expect(f.store.getSharedConversation(f.room.sessionId)?.closedAt).toBeNull();
});

test("bad/mixed token, stale state and spoofed caller read zero utterances", async () => {
  const f = await fixture();
  for (const [override, status] of [
    [{ sessionToken: "bad" }, 401], [{ sessionToken: f.bruno.sessionToken }, 401],
    [{ stateHash: "stale" }, 409], [{ callerId: "eli" }, 400], [{ agentId: "eli" }, 400],
  ] as const) expect((await f.read({ ...f.request(), ...override })).status).toBe(status);
  expect(f.reads()).toBe(0);
});

test("a valid lease for a non-reader cannot impersonate a room member", async () => {
  const f = await fixture();
  expect((await f.read(f.request(f.bruno))).status).toBe(403);
  expect(f.reads()).toBe(0);
});

test("disabled read integration refuses before any utterance read", async () => {
  const f = await fixture(); f.disable();
  expect((await f.read()).status).toBe(503);
  expect(f.reads()).toBe(0);
});

test("audience change and room vacancy invalidate the exact epoch binding", async () => {
  const f = await fixture(); f.changeAudience();
  expect((await f.read()).status).toBe(409);
  expect(f.reads()).toBe(0);
  const second = await fixture(); second.store.markPlaceVacant("chamber_eli");
  expect((await second.read()).status).toBe(409);
  expect(second.reads()).toBe(0);
});

test("closed and mismatched room epochs never read their history", async () => {
  const f = await fixture();
  expect((await f.read({ ...f.request(), conversationId: "foreign-epoch" })).status).toBe(409);
  f.store.closeSharedConversation(f.room.sessionId);
  expect((await f.read()).status).toBe(409);
  expect(f.reads()).toBe(0);
});

test("expired leases and wrong continuity grants cannot reach utterances", async () => {
  const f = await fixture();
  const joined = await f.services.get("eli")!.compile({ identity: "eli", surfaceId: "another", message: "join" });
  await expect(f.services.get("bruno")!.readRoom({
    grantId: joined.grant.grantId, stateHash: joined.grant.stateHash,
    placeId: "chamber_eli", conversationId: f.room.sessionId,
  })).rejects.toThrow("grant is unavailable");
  f.expire();
  expect((await f.read()).status).toBe(401);
  expect(f.reads()).toBe(0);
});

test("production room-read gate stays off before opening any database", () => {
  const shared = Bun.env.ANIMA_SHARED_CONVERSATIONS, external = Bun.env.ANIMA_EXTERNAL_SHARED_READS;
  try {
    for (const [a, b] of [["1", "0"], ["0", "1"], ["0", "0"]]) {
      Bun.env.ANIMA_SHARED_CONVERSATIONS = a; Bun.env.ANIMA_EXTERNAL_SHARED_READS = b;
      expect(() => readExternalSharedRoom({ roomsDir: "/missing-room-fixture", knownAgentIds: ["eli"] },
        "eli", "room", "epoch")).toThrow("disabled");
    }
  } finally {
    if (shared === undefined) delete Bun.env.ANIMA_SHARED_CONVERSATIONS; else Bun.env.ANIMA_SHARED_CONVERSATIONS = shared;
    if (external === undefined) delete Bun.env.ANIMA_EXTERNAL_SHARED_READS; else Bun.env.ANIMA_EXTERNAL_SHARED_READS = external;
  }
});

test("room response byte bound refuses oversized UTF-8 without returning history", async () => {
  const f = await fixture();
  f.store.appendSharedUtterance({
    conversationId: f.room.sessionId, speakerId: "eli", role: "assistant",
    content: "🧪".repeat(4400), utteranceKey: "large-turn", requestId: "large-request", source: "ui",
  });
  const response = await f.read();
  expect(response.status).toBe(409);
  const body = await response.text();
  expect(body).toContain("16 KiB");
  expect(body).not.toContain("🧪");
});
