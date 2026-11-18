import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore, HostSession, type SessionState } from "./host-session.ts";

const ORIGIN = "http://127.0.0.1:13541";

/** Scripted runtime: records calls, answers by path. */
function fakeRuntime(handlers: Partial<Record<string, (body: any, n: number) => Response | Promise<Response>>>) {
  const calls: Array<{ path: string; body: any }> = [];
  const counts: Record<string, number> = {};
  const fetcher = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    counts[path] = (counts[path] ?? 0) + 1;
    const handler = handlers[path];
    if (!handler) return Response.json({ error: "not found" }, { status: 404 });
    return handler(body, counts[path]);
  };
  return { calls, fetcher };
}

const joinBody = (n: number, expiresAt: number) => ({
  projection: "PROJECTION",
  projectionId: `p${n}`,
  stateHash: `hash${n}`,
  leaseId: `lease${n}`,
  expiresAt,
  writeScopes: ["observation", "fact"],
  declaredSubstrateScopes: [],
  scopeDeclarationStatus: "unimplemented",
  sessionToken: `token${n}`,
});

let dir: string;
let statePath: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "host-session-"));
  statePath = join(dir, "session.json");
  clock = 1_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make(handlers: Parameters<typeof fakeRuntime>[0]) {
  const rt = fakeRuntime(handlers);
  const session = new HostSession({
    origin: ORIGIN,
    tenant: "bruno",
    clientId: "claude-mac",
    surfaceId: "claude-code-hook",
    store: new FileSessionStore(statePath),
    fetcher: rt.fetcher,
    now: () => clock,
  });
  return { rt, session };
}

describe("ensure()", () => {
  test("joins on the tenant path and persists the whole session with mode 0600", async () => {
    const { rt, session } = make({
      "/identity-runtime/bruno/join": (_b, n) => Response.json(joinBody(n, clock + 30 * 60_000)),
    });
    const s = await session.ensure();
    expect(s).toMatchObject({ leaseId: "lease1", sessionToken: "token1", stateHash: "hash1" });
    expect(rt.calls[0].body).toMatchObject({ clientId: "claude-mac", surfaceId: "claude-code-hook" });
    expect(rt.calls[0].body.agentId).toBeUndefined();
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as SessionState;
    expect(saved).toMatchObject({ leaseId: "lease1", sessionToken: "token1", expiresAt: clock + 30 * 60_000 });
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  test("does not persist the (large) projection text", async () => {
    const { session } = make({ "/identity-runtime/bruno/join": (_b, n) => Response.json(joinBody(n, clock + 1_800_000)) });
    await session.ensure();
    expect(readFileSync(statePath, "utf8")).not.toContain("PROJECTION");
  });

  test("reuses a still-valid stored session without calling join again — even from a new process", async () => {
    const a = make({ "/identity-runtime/bruno/join": (_b, n) => Response.json(joinBody(n, clock + 1_800_000)) });
    await a.session.ensure();
    const b = make({}); // a new HostSession over the same state file; runtime would 404 any call
    const s = await b.session.ensure();
    expect(s.leaseId).toBe("lease1");
    expect(b.rt.calls).toHaveLength(0);
  });

  test("re-joins when the stored lease expires within the renew margin", async () => {
    const { rt, session } = make({
      "/identity-runtime/bruno/join": (_b, n) => Response.json(joinBody(n, clock + 1_800_000)),
    });
    await session.ensure();
    clock += 1_800_000 - 30_000; // 30s left, margin is 60s
    const s = await session.ensure();
    expect(s.leaseId).toBe("lease2");
    expect(rt.calls.filter((c) => c.path.endsWith("/join"))).toHaveLength(2);
  });

  test("ignores a stored session that belongs to another origin/tenant/client", async () => {
    const store = new FileSessionStore(statePath);
    store.save({ origin: "http://elsewhere:1", tenant: "bruno", clientId: "claude-mac", surfaceId: "x", leaseId: "old", sessionToken: "old", stateHash: "old", expiresAt: clock + 1_800_000, joinedAt: clock });
    const { session } = make({ "/identity-runtime/bruno/join": (_b, n) => Response.json(joinBody(n, clock + 1_800_000)) });
    expect((await session.ensure()).leaseId).toBe("lease1");
  });

  test("a failed join throws with the runtime's error message", async () => {
    const { session } = make({ "/identity-runtime/bruno/join": () => Response.json({ error: "admission denied" }, { status: 401 }) });
    await expect(session.ensure()).rejects.toThrow("admission denied");
  });

  test("a corrupt state file is treated as no session", async () => {
    await Bun.write(statePath, "{not json");
    const { session } = make({ "/identity-runtime/bruno/join": (_b, n) => Response.json(joinBody(n, clock + 1_800_000)) });
    expect((await session.ensure()).leaseId).toBe("lease1");
  });
});

describe("directRecall()", () => {
  const recallPath = "/identity-runtime/continuity/direct-recall";

  test("sends lease credentials and the query, returns results", async () => {
    const { rt, session } = make({
      "/identity-runtime/bruno/join": (_b, n) => Response.json(joinBody(n, clock + 1_800_000)),
      [recallPath]: () => Response.json([{ source: "bruno_entity", content: "a memory" }]),
    });
    const out = await session.directRecall("what did we decide");
    expect(out).toEqual([{ source: "bruno_entity", content: "a memory" }]);
    const call = rt.calls.find((c) => c.path === recallPath)!;
    // stateHash is required by the runtime: direct recall is fail-closed on a stale one.
    expect(call.body).toEqual({ leaseId: "lease1", clientId: "claude-mac", sessionToken: "token1", stateHash: "hash1", query: "what did we decide" });
  });

  test("on 'direct-recall stateHash is stale' it re-joins and retries once with the fresh hash", async () => {
    const { rt, session } = make({
      "/identity-runtime/bruno/join": (_b, n) => Response.json(joinBody(n, clock + 1_800_000)),
      [recallPath]: (body, n) =>
        n === 1 ? Response.json({ error: "direct-recall stateHash is stale" }, { status: 409 }) : Response.json([{ source: "rag", content: `ok ${body.stateHash}` }]),
    });
    expect(await session.directRecall("q")).toEqual([{ source: "rag", content: "ok hash2" }]);
    expect(rt.calls.filter((c) => c.path === recallPath)).toHaveLength(2);
  });

  test("on 'lease is unavailable' it re-joins and retries exactly once", async () => {
    const { rt, session } = make({
      "/identity-runtime/bruno/join": (_b, n) => Response.json(joinBody(n, clock + 1_800_000)),
      [recallPath]: (body, n) =>
        n === 1 ? Response.json({ error: "lease is unavailable" }, { status: 409 }) : Response.json([{ source: "rag", content: `ok ${body.leaseId}` }]),
    });
    const out = await session.directRecall("q");
    expect(out).toEqual([{ source: "rag", content: "ok lease2" }]);
    expect(rt.calls.filter((c) => c.path.endsWith("/join"))).toHaveLength(2);
  });

  test("does not retry forever: a second failure propagates", async () => {
    const { rt, session } = make({
      "/identity-runtime/bruno/join": (_b, n) => Response.json(joinBody(n, clock + 1_800_000)),
      [recallPath]: () => Response.json({ error: "lease is unavailable" }, { status: 409 }),
    });
    await expect(session.directRecall("q")).rejects.toThrow("lease is unavailable");
    expect(rt.calls.filter((c) => c.path === recallPath)).toHaveLength(2);
  });

  test("an unrelated error is not retried", async () => {
    const { rt, session } = make({
      "/identity-runtime/bruno/join": (_b, n) => Response.json(joinBody(n, clock + 1_800_000)),
      [recallPath]: () => Response.json({ error: "tenant direct recall is unavailable" }, { status: 409 }),
    });
    await expect(session.directRecall("q")).rejects.toThrow("tenant direct recall is unavailable");
    expect(rt.calls.filter((c) => c.path === recallPath)).toHaveLength(1);
  });
});

describe("remember()", () => {
  const rememberPath = "/identity-runtime/continuity/remember";
  const okJoin = { "/identity-runtime/bruno/join": (_b: any, n: number) => Response.json(joinBody(n, clock + 1_800_000)) };

  test("sends stateHash, an idempotency key and the entry with defaults", async () => {
    const { rt, session } = make({ ...okJoin, [rememberPath]: () => Response.json({ id: "m1", createdAt: "2026-09-19T00:00:00Z" }) });
    const r = await session.remember({ content: "a real note", source: "claude-mac" });
    expect(r).toEqual({ id: "m1", createdAt: "2026-09-19T00:00:00Z" });
    const body = rt.calls.find((c) => c.path === rememberPath)!.body;
    expect(body).toMatchObject({ leaseId: "lease1", clientId: "claude-mac", sessionToken: "token1", stateHash: "hash1" });
    expect(typeof body.idempotencyKey).toBe("string");
    expect(body.entry).toEqual({ scope: "observation", content: "a real note", tags: [], confidence: 0.7, source: "claude-mac" });
  });

  test("the idempotency key is stable for identical content and differs for different content", async () => {
    const keys: string[] = [];
    const { session } = make({ ...okJoin, [rememberPath]: (b: any) => { keys.push(b.idempotencyKey); return Response.json({ id: "x", createdAt: "t" }); } });
    await session.remember({ content: "same", source: "s" });
    await session.remember({ content: "same", source: "s" });
    await session.remember({ content: "other", source: "s" });
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  test("on 'stateHash is stale' it re-joins and retries once with the fresh hash", async () => {
    const { rt, session } = make({
      ...okJoin,
      [rememberPath]: (b: any, n: number) =>
        n === 1 ? Response.json({ error: "remember stateHash is stale" }, { status: 409 }) : Response.json({ id: `saved-with-${b.stateHash}`, createdAt: "t" }),
    });
    const r = await session.remember({ content: "c", source: "s" });
    expect(r.id).toBe("saved-with-hash2");
    expect(rt.calls.filter((c) => c.path === rememberPath)).toHaveLength(2);
  });

  // SC-005: one lease carries one write (a write advances ANIMA's revision, the
  // lease's hash does not), so the spent session is dropped, not reused.
  test("after a successful remember the next call joins afresh instead of reusing the spent hash", async () => {
    const { rt, session } = make({
      ...okJoin,
      [rememberPath]: (b: any) => Response.json({ id: `saved-with-${b.stateHash}`, createdAt: "t" }),
    });
    const first = await session.remember({ content: "one", source: "s" });
    const second = await session.remember({ content: "two", source: "s" });

    expect(first.id).toBe("saved-with-hash1");
    expect(second.id).toBe("saved-with-hash2");
    expect(rt.calls.filter((c) => c.path === "/identity-runtime/bruno/join")).toHaveLength(2);
    expect(rt.calls.filter((c) => c.path === rememberPath)).toHaveLength(2); // no wasted stale round-trip
  });

  test("rejects empty content locally without calling the runtime", async () => {
    const { rt, session } = make(okJoin);
    await expect(session.remember({ content: "   ", source: "s" })).rejects.toThrow("content is required");
    expect(rt.calls).toHaveLength(0);
  });
});

describe("FileSessionStore", () => {
  test("load() returns undefined when the file does not exist", () => {
    expect(new FileSessionStore(join(dir, "nope", "session.json")).load()).toBeUndefined();
  });

  test("save() creates missing parent directories", () => {
    const p = join(dir, "a", "b", "session.json");
    new FileSessionStore(p).save({ origin: ORIGIN, tenant: "bruno", clientId: "c", surfaceId: "s", leaseId: "l", sessionToken: "t", stateHash: "h", expiresAt: 1, joinedAt: 1 });
    expect(existsSync(p)).toBe(true);
  });
});
