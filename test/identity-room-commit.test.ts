import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/memory/session-store";
import { ConversationService } from "../src/conversation/service";
import { SharedTurnCoordinator } from "../src/conversation/coordinator";
import { createSharedRoomCommitter, commitExternalSharedRoom } from "../src/identity-runtime/shared-room-commit";
import { AnimaContinuityService } from "../src/identity-runtime/continuity-service";
import { ProjectionGrantStore } from "../src/identity-runtime/projection-grant-store";
import { handleTenantContinuityRequest } from "../src/api/identity-runtime/handlers";
import { HttpAnimaTenantContinuityClient } from "../packages/identity-runtime/src/anima-continuity-client";
import { TenantIdentityRuntime } from "../packages/identity-runtime/src/tenant-runtime";
import { startTenantIdentityRuntimeHttp } from "../packages/identity-runtime/src/tenant-http";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "anima-room-commit-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SessionStore(join(root, "sessions.db"));
  cleanups.push(() => store.close());
  let occupants = ["eli"], enabled = true, maySpeak = true, now = 100;
  const authority = new ConversationService({
    store, operatorId: "owner", resolvePlace: placeId => ({ placeId, occupants, visibility: "members" }),
    isKnownColonyPrincipal: id => ["eli", "bruno"].includes(id),
  });
  const room = authority.getOrCreateAmbientForSpeech("chamber_eli").conversation;
  const commit = createSharedRoomCommitter({
    store, conversationService: authority, enabled: () => enabled,
    maySpeak: id => id === "eli" && maySpeak,
  });
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
      remember: async () => { throw Error("unexpected memory write"); }, recall: async () => [],
      commitRoom: commit,
    }));
  }
  let delegationFails = false;
  const runtime = new TenantIdentityRuntime({
    dbPath: join(root, "runtime.db"), now: () => now, log: () => {},
    tenants: new Map(["eli", "bruno"].map(id => [id, {
      continuity: new HttpAnimaTenantContinuityClient("http://anima.test", id,
        (input, init) => {
          if (delegationFails && input.endsWith("/commit-room")) throw Error("PRIVATE_UPSTREAM_ERROR");
          return handleTenantContinuityRequest(new Request(input, init), agent => services.get(agent));
        }),
    }])),
  });
  cleanups.push(() => runtime.close());
  const server = startTenantIdentityRuntimeHttp(runtime, "127.0.0.1", 0);
  cleanups.push(() => server.stop(true));
  async function post(path: string, body: unknown) {
    return fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  }
  async function lease(agent: string) {
    return await (await post(`/identity-runtime/${agent}/join`, {
      clientId: "pi-soffio-room", surfaceId: `room-${agent}`, message: "join",
    })).json() as any;
  }
  const eli = await lease("eli"), bruno = await lease("bruno");
  const request = (identity = eli) => ({
    leaseId: identity.leaseId, sessionToken: identity.sessionToken, stateHash: identity.stateHash,
    clientId: "pi-soffio-room", placeId: "chamber_eli", conversationId: room.sessionId,
    requestKey: "line-one", text: "Canonical speech",
  });
  return { root, store, authority, room, services, eli, bruno, request,
    post, commit: (body = request()) => post("/identity-runtime/shared/commit-room", body),
    disable: () => { enabled = false; }, revoke: () => { maySpeak = false; },
    expire: () => { now = 10_000_000; }, audience: () => { occupants = ["bruno"]; },
    failDelegation: () => { delegationFails = true; } };
}

// @spec Canonical commit SHALL authenticate independent speech authority / Valid commit and durable replay
test("leased speaker commits exactly one canonical assistant row; concurrent retry returns same receipt", async () => {
  const f = await fixture();
  const responses = await Promise.all([f.commit(), f.commit()]);
  const receipts = await Promise.all(responses.map(r => r.json()));
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  expect(receipts[0]).toEqual(receipts[1]);
  expect(receipts[0]).toEqual({
    status: "committed", placeId: "chamber_eli", conversationId: f.room.sessionId,
    requestKey: "line-one", speakerId: "eli", turnId: expect.any(Number),
  });
  const rows = f.store.getSharedUtterances(f.room.sessionId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ role: "assistant", speakerId: "eli", content: "Canonical speech" });
  expect(JSON.stringify(receipts)).not.toContain("PRIVATE");
  expect(JSON.stringify(receipts)).not.toContain(f.eli.sessionToken);
});

test("receipt lookup is durable and independent of the 100-row history window", async () => {
  const f = await fixture();
  for (let i = 0; i < 105; i++) f.store.appendSharedUtterance({
    conversationId: f.room.sessionId, speakerId: "eli", role: "assistant",
    content: "history", utteranceKey: `old-${i}`, requestId: `old-${i}`, source: "ui",
  });
  const first = await (await f.commit()).json() as any;
  expect(first.status).toBe("committed");
  expect(first.turnId).toBeGreaterThan(105);
  const reopened = new SessionStore(join(f.root, "sessions.db"));
  try {
    const otherCommit = createSharedRoomCommitter({
      store: reopened, conversationService: f.authority, enabled: () => true, maySpeak: () => true,
    });
    expect(await otherCommit("eli", {
      placeId: "chamber_eli", conversationId: f.room.sessionId, requestKey: "line-one", text: "Canonical speech",
    })).toEqual(first);
  } finally { reopened.close(); }
});

// @spec Canonical commit SHALL authenticate independent speech authority / Invalid identity or speech authority
test("bad/mixed credentials, stale state and speaker/source overrides write zero turns", async () => {
  const f = await fixture();
  for (const override of [
    { sessionToken: "wrong" }, { sessionToken: f.bruno.sessionToken }, { stateHash: "stale" },
    { speakerId: "bruno" }, { agentId: "bruno" }, { source: "meeting" }, { readerIds: ["eli"] },
  ]) {
    const response = await f.commit({ ...f.request(), ...override });
    expect(response.ok).toBe(false);
    expect(await response.json()).toMatchObject({ rejectedBeforeCommit: true });
  }
  f.revoke();
  expect((await f.commit()).status).toBe(403);
  expect(f.store.getSharedUtterances(f.room.sessionId)).toHaveLength(0);
});

test("a valid foreign grant cannot select the continuity speaker", async () => {
  const f = await fixture();
  const remote = await f.services.get("bruno")!.compile({ identity: "bruno", surfaceId: "foreign", message: "join" });
  await expect(f.services.get("eli")!.commitRoom({
    grantId: remote.grant.grantId, stateHash: remote.grant.stateHash,
    placeId: "chamber_eli", conversationId: f.room.sessionId, requestKey: "k", text: "spoof",
  })).rejects.toThrow("grant");
  expect(f.store.getSharedUtterances(f.room.sessionId)).toHaveLength(0);
});

test("independent speech allowlist still requires canonical speaker access", async () => {
  const f = await fixture();
  const commit = createSharedRoomCommitter({
    store: f.store, conversationService: f.authority, enabled: () => true, maySpeak: () => true,
  });
  await expect(commit("bruno", {
    placeId: "chamber_eli", conversationId: f.room.sessionId, requestKey: "outside", text: "not a member",
  })).rejects.toThrow("denied");
  expect(f.store.getSharedUtterances(f.room.sessionId)).toHaveLength(0);
});

// @spec Canonical commit SHALL fence epoch and cancellation at write time / Stale or revoked authority while queued
test.each(["audience", "vacancy", "closed", "mismatch", "disabled", "expired"] as const)(
  "%s binding refuses without new turns or a manufactured room", async condition => {
    const f = await fixture();
    if (condition === "audience") f.audience();
    if (condition === "vacancy") f.store.markPlaceVacant("chamber_eli");
    if (condition === "closed") f.store.closeSharedConversation(f.room.sessionId);
    if (condition === "disabled") f.disable();
    if (condition === "expired") f.expire();
    const response = await f.commit({ ...f.request(), conversationId: condition === "mismatch" ? "foreign" : f.room.sessionId });
    expect(response.ok).toBe(false);
    expect(await response.json()).toMatchObject({ rejectedBeforeCommit: true });
    expect(f.store.getSharedUtterances(f.room.sessionId)).toHaveLength(0);
    expect(f.store.getOpenAmbientConversation("chamber_eli")?.sessionId ?? null)
      .toBe(condition === "closed" ? null : f.room.sessionId);
  },
);

test.each(["audience", "revoke", "disable", "expire", "cancel"] as const)(
  "queued commit rechecks %s inside the canonical coordinator", async condition => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<string | null>(r => { release = () => r(null); });
    const admitted = new Promise<void>(r => { entered = r; });
    const holder = new SharedTurnCoordinator(f.store).submit({
      conversationId: f.room.sessionId, requestKey: "holder", inputHash: "holder",
      speakerId: "eli", userId: "@external", userText: "", omitInputUtterance: true,
    }, () => { entered(); return blocked; });
    await admitted;
    const remote = await f.services.get("eli")!.compile({ identity: "eli", surfaceId: "queue", message: "join" });
    const cancellation = new AbortController();
    const operation = f.services.get("eli")!.commitRoom({
      grantId: remote.grant.grantId, stateHash: remote.grant.stateHash,
      placeId: "chamber_eli", conversationId: f.room.sessionId, requestKey: "queued", text: "too late",
    }, cancellation.signal);
    const outcome = operation.catch(e => e);
    await new Promise(r => setTimeout(r, 0));
    if (condition === "cancel") cancellation.abort();
    else f[condition]();
    release(); await holder;
    expect(await outcome).toBeInstanceOf(Error);
    expect(f.store.getSharedUtterances(f.room.sessionId)).toHaveLength(0);
  },
);

// @spec Canonical commit SHALL fence epoch and cancellation at write time / Cancelled work never commits after its observed fence
test("coordinator synchronous write fence catches revocation after generation await", async () => {
  const f = await fixture();
  let allowed = true;
  await expect(new SharedTurnCoordinator(f.store).submit({
    conversationId: f.room.sessionId, requestKey: "fenced", inputHash: "fenced",
    speakerId: "eli", userId: "@external", userText: "", omitInputUtterance: true,
    authorize: () => { if (!allowed) throw Error("revoked"); },
  }, async () => { allowed = false; return "late"; })).rejects.toThrow("revoked");
  expect(f.store.getSharedUtterances(f.room.sessionId)).toHaveLength(0);
});

test("internal HTTP preserves the observed cancellation signal across delegation while queued", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const admitted = new Promise<void>(r => { entered = r; });
  const blocked = new Promise<string | null>(r => { release = () => r(null); });
  const holder = new SharedTurnCoordinator(f.store).submit({
    conversationId: f.room.sessionId, requestKey: "signal-holder", inputHash: "holder",
    speakerId: "eli", userId: "@external", userText: "", omitInputUtterance: true,
  }, () => { entered(); return blocked; });
  await admitted;
  const cancellation = new AbortController();
  const client = new HttpAnimaTenantContinuityClient("http://anima.test", "eli",
    (input, init) => handleTenantContinuityRequest(new Request(input, init), id => f.services.get(id)));
  const remote = await f.services.get("eli")!.compile({ identity: "eli", surfaceId: "signal", message: "join" });
  const result = client.commitRoom({
    grantId: remote.grant.grantId, stateHash: remote.grant.stateHash,
    placeId: "chamber_eli", conversationId: f.room.sessionId, requestKey: "signal-key", text: "too late",
  }, cancellation.signal).catch(e => e);
  await new Promise(r => setTimeout(r, 0));
  cancellation.abort(); release(); await holder;
  expect(await result).toMatchObject({ name: "RoomCommitRejectedError" });
  expect(f.store.getSharedUtterances(f.room.sessionId)).toHaveLength(0);
});

// @spec Canonical commit SHALL bound input and preserve outcomes / Bad input and conflicting replay refuse
test("bounded text/key validation and conflicting replay preserve prior data", async () => {
  const f = await fixture();
  for (const override of [{ text: "" }, { text: " " }, { text: "🧪".repeat(1001) }, { requestKey: "" }]) {
    expect((await f.commit({ ...f.request(), ...override })).ok).toBe(false);
  }
  const receipt = await (await f.commit()).json();
  expect((await f.commit({ ...f.request(), text: "different" })).ok).toBe(false);
  expect(await (await f.commit()).json()).toEqual(receipt);
  expect(f.store.getSharedUtterances(f.room.sessionId)).toHaveLength(1);
});

// @spec Canonical commit SHALL bound input and preserve outcomes / Unknown outcome remains unknown
test("unmarked upstream failure is sanitized and never called a proven rejection", async () => {
  const f = await fixture(); f.failDelegation();
  const response = await f.commit();
  expect(response.ok).toBe(false);
  expect(await response.json()).toEqual({ error: "shared room commit outcome unknown" });
});

test("lost acknowledgement after append stays unknown and same-key replay recovers one turn", async () => {
  const f = await fixture();
  const append = f.store.appendSharedUtterance.bind(f.store);
  let fail = true;
  f.store.appendSharedUtterance = input => {
    const row = append(input);
    if (fail) { fail = false; throw Error("PRIVATE_SQL_AFTER_APPEND"); }
    return row;
  };
  const first = await f.commit();
  expect(first.status).toBe(503);
  expect(await first.json()).toEqual({ error: "shared room commit outcome unknown" });
  const retry = await (await f.commit()).json() as any;
  expect(retry.status).toBe("committed");
  expect(f.store.getSharedUtterances(f.room.sessionId)).toHaveLength(1);
});

test("a conflicting request in another conversation cannot fail the active request it does not own", async () => {
  const f = await fixture();
  const other = f.authority.getOrCreateAmbientForSpeech("other-room").conversation;
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(r => { entered = r; });
  const blocked = new Promise<string>(r => { release = () => r("original"); });
  const input = {
    conversationId: f.room.sessionId, requestKey: "same-key", inputHash: "same-hash",
    speakerId: "eli", userId: "@external", userText: "", omitInputUtterance: true,
  };
  const first = new SharedTurnCoordinator(f.store).submit(input, () => { entered(); return blocked; });
  await enteredPromise;
  try {
    await expect(new SharedTurnCoordinator(f.store).submit({
      ...input, conversationId: other.sessionId, inputHash: "different-hash",
    }, async () => "conflict")).rejects.toThrow("conflicts");
    expect(f.store.getSharedRequest("same-key")?.status).toBe("running");
  } finally { release(); await first; }
});

// @spec Production commit SHALL remain opt-in / Default-off integration
test("production commit refuses flags or missing speaker allowlist before opening databases", async () => {
  const keys = ["ANIMA_SHARED_CONVERSATIONS", "ANIMA_EXTERNAL_SHARED_COMMITS", "ANIMA_EXTERNAL_SHARED_SPEAKERS"] as const;
  const prior = keys.map(k => Bun.env[k]);
  try {
    for (const [shared, external, speakers] of [["0", "1", "eli"], ["1", "0", "eli"], ["1", "1", ""], ["1", "1", "bruno"]]) {
      [Bun.env.ANIMA_SHARED_CONVERSATIONS, Bun.env.ANIMA_EXTERNAL_SHARED_COMMITS, Bun.env.ANIMA_EXTERNAL_SHARED_SPEAKERS] = [shared, external, speakers];
      await expect(commitExternalSharedRoom({ roomsDir: "/missing", knownAgentIds: ["eli"] }, "eli", {
        placeId: "room", conversationId: "epoch", requestKey: "key", text: "speech",
      })).rejects.toThrow(shared === "0" || external === "0" ? "disabled" : "denied");
    }
  } finally { keys.forEach((k, i) => { if (prior[i] === undefined) delete Bun.env[k]; else Bun.env[k] = prior[i]; }); }
});
