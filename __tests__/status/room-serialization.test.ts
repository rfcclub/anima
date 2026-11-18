import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTalk } from "../../src/ui/features/town/api/talk";
import { getSharedNarrativeStore, __resetSharedNarrativeStore } from "../../src/narrative/shared-store";
import { readTranscript } from "../../src/narrative/room-transcript";
import { SessionStore } from "../../src/memory/session-store";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

// Per-room FIFO serialization. Two
// concurrent POST /api/talk/:agent calls used to run two pipelines, racing
// on the session turns read-modify-write and scrambling transcript ordering.
// runExclusive (room-lock.ts) serializes them.

function makeDeferredProvider(name: string): { provider: Provider; release: () => void; state: { queryStarted: boolean } } {
  let release!: () => void;
  const state = { queryStarted: false };
  const provider: Provider = {
    name,
    async query(_req: ProviderRequest): Promise<ProviderResponse> {      state.queryStarted = true;
      await new Promise<void>((r) => { release = r; });
      return {
        message: { role: "assistant", content: "reply" },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  } as unknown as Provider;
  return { provider, release: () => release(), state };
}

function makeConfig(label: string, roomsDir: string): string {
  const name = label.toLowerCase();
  return [
    "identity:",
    `  name: ${name}`,
    `  label: ${label}`,
    "  identityAnchor: test",
    "boot:",
    "  gene: AGENTS.md",
    "  soul: SOUL.md",
    "  sessionContext:",
    "  - MEMORY.md",
    "memory:",
    "  store: jsonl",
    "session:",
    "  defaultMode: plan",
    "  compactThreshold: 50",
    "provider:",
    "  type: mock",
    "  model: mock-model",
    "policy:",
    "  allowedRoots:",
    `  - ${join(roomsDir, name)}`,
    "reflection:",
    "  enabled: false",
  ].join("\n");
}

function setupRoom(roomsDir: string, name: string) {
  const dir = join(roomsDir, name);
  mkdirSync(dir, { recursive: true });
  const label = name === "bruno" ? "Bruno" : name === "eli" ? "Eli" : "Lena";
  writeFileSync(join(dir, "config.yaml"), makeConfig(label, roomsDir));
  writeFileSync(join(dir, "AGENTS.md"), `# ${name}`);
  writeFileSync(join(dir, "SOUL.md"), `# ${name} soul`);
  writeFileSync(join(dir, "MEMORY.md"), "");
}

function parseFrames(text: string): { done: boolean; agentTexts: Record<string, string> } {
  let done = false;
  const agentTexts: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const v = line.slice(6);
    if (v === "[DONE]") { done = true; continue; }
    if (v.startsWith("{")) {
      try {
        const f = JSON.parse(v) as { agent?: string; type?: string; content?: string };
        if (f.agent && f.type === "text" && f.content) {
          agentTexts[f.agent] = (agentTexts[f.agent] ?? "") + f.content;
        }
      } catch { /* ignore */ }
    }
  }
  return { done, agentTexts };
}

describe("room-request-serialization", () => {
  let roomsDir: string;
  let transcriptsDir: string;
  let sessionsDb: string;

  beforeEach(() => {
    __resetSharedNarrativeStore();
    process.env.ANIMA_TEST_PROVIDERS = "true";
    roomsDir = mkdtempSync(join(tmpdir(), "anima-ser-"));
    transcriptsDir = mkdtempSync(join(tmpdir(), "anima-trans-"));
    // talk.ts's getSessionStore() resolves the session DB to
    // defaultStateDir()/sessions.db, honoring ANIMA_UI_STATE_DIR. Point it at
    // the temp rooms dir so SC-101/SC-103 can read session turns back.
    sessionsDb = join(roomsDir, "sessions.db");
    process.env.ANIMA_TRANSCRIPTS_DIR = transcriptsDir;
    process.env.ANIMA_UI_STATE_DIR = roomsDir;
    for (const name of ["bruno", "eli", "lena"]) setupRoom(roomsDir, name);
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.seedPlacesFromRoster(["bruno", "eli", "lena"]);
  });

  afterEach(() => {
    __resetSharedNarrativeStore();
    delete process.env.ANIMA_TEST_PROVIDERS;
    delete process.env.ANIMA_TRANSCRIPTS_DIR;
    delete process.env.ANIMA_UI_STATE_DIR;
    rmSync(roomsDir, { recursive: true, force: true });
    rmSync(transcriptsDir, { recursive: true, force: true });
  });

  test("SC-102: concurrent sends preserve transcript ordering (not interleaved)", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });

    const { provider: provA, release: releaseA, state: stateA } = makeDeferredProvider("mockA");
    const { provider: provB, release: releaseB, state: stateB } = makeDeferredProvider("mockB");    const providers = new Map<string, Provider>([["eli", provA]]);
    const providersB = new Map<string, Provider>([["eli", provB]]);

    const reqA = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "question A" }),
    });
    const reqB = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "question B" }),
    });

    // Start A (in flight, deferred). Drain A's stream in the background so its
    // start() body (provider query) actually runs.
    const resAPromise = handleTalk(reqA, "eli", { roomsDir, providers });
    // Kick the stream: await the Response, then drain its body in the background.
    const resA = await resAPromise;
    const drainA = resA.text();
    // Let A's provider query start (so it holds the lock). Poll — agent load +
    // context assembly can take ~100ms.
    for (let i = 0; i < 60 && !stateA.queryStarted; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stateA.queryStarted).toBe(true);
    // Start B WITHOUT awaiting — withRoomLock(B) awaits A's release, so
    // resBPromise won't resolve until A drains. Kick it in the background.
    const resBPromise = handleTalk(reqB, "eli", { roomsDir, providers: providersB });
    // B must NOT have started its provider query — it's queued behind A.
    await new Promise((r) => setTimeout(r, 100));
    expect(stateB.queryStarted).toBe(false);

    // Release A → A's stream completes → lock releases → B's withRoomLock
    // resolves → B's provider query starts.
    releaseA();
    const resB = await resBPromise;
    const drainB = resB.text();
    for (let i = 0; i < 60 && !stateB.queryStarted; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stateB.queryStarted).toBe(true);
    releaseB();
    await drainA;
    await drainB;

    const turns = readTranscript("eli", join(roomsDir, "_shared", "transcripts"));
    const userTurns = turns.filter((t) => t.role === "user").map((t) => t.content);
    // Both user turns present, and A's user turn strictly before B's (not interleaved).
    expect(userTurns).toContain("question A");
    expect(userTurns).toContain("question B");
    expect(userTurns.indexOf("question A")).toBeLessThan(userTurns.indexOf("question B"));
  }, 20000);

  test("SC-105: town surface (non-VN) returns plain JSON-string SSE frames", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });

    const providers = new Map<string, Provider>([
      ["eli", {
        name: "mock",
        async query(_req: ProviderRequest): Promise<ProviderResponse> {
          return {
            message: { role: "assistant", content: "town reply" },
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      } as unknown as Provider],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json" }, // no /rooms/ referer → town surface
      body: JSON.stringify({ message: "hi" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    const text = await res.text();
    // Town surface: plain JSON-string frames (not {agent,type,content} tagged)
    expect(text).toContain('data: "');
    expect(text).not.toContain('"agent":"eli"');
    expect(text).toContain("[DONE]");
  }, 15000);

  test("SC-101: concurrent sends preserve session alternation", async () => {
    // Two concurrent VN-surface requests to eli (alone in chamber_eli).
    // withRoomLock serializes them: B's pipeline runs after A completes, so
    // B's priorMessages includes A's exchange and eli's session reads
    // user_A, assistant_A, user_B, assistant_B in that order.
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });

    const { provider: provA, release: releaseA, state: stateA } = makeDeferredProvider("mockA");
    // B is a normal (non-deferred) provider: once A releases the lock, B runs
    // to completion on its own. B must NOT start before A releases (the lock
    // holds it), which is the serialization under test.
    const provB: Provider = {
      name: "mockB",
      async query(_req: ProviderRequest): Promise<ProviderResponse> {
        return {
          message: { role: "assistant", content: "reply B" },
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    } as unknown as Provider;
    const providersA = new Map<string, Provider>([["eli", provA]]);
    const providersB = new Map<string, Provider>([["eli", provB]]);

    const reqA = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "question A" }),
    });
    const reqB = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "question B" }),
    });

    const resA = await handleTalk(reqA, "eli", { roomsDir, providers: providersA });
    const drainA = resA.text();
    for (let i = 0; i < 60 && !stateA.queryStarted; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stateA.queryStarted).toBe(true);

    // B queued behind A — has not started its provider query.
    const resBPromise = handleTalk(reqB, "eli", { roomsDir, providers: providersB });
    await new Promise((r) => setTimeout(r, 100));

    // Release A → A completes → lock frees → B runs to completion.
    releaseA();
    const resB = await resBPromise;
    await drainA;
    await resB.text();

    // eli's session: user_A, assistant_A, user_B, assistant_B — strictly
    // alternating, no interleaving. (SC-101)
    const sessionStore = new SessionStore(sessionsDb);
    const session = sessionStore.getLatestSession("eli", "ui");
    expect(session).not.toBeNull();
    const turns = sessionStore.getTurns(session!.id);
    const roles = turns.map((t) => t.role);
    const userAIdx = turns.findIndex((t) => t.role === "user" && t.content === "question A");
    const userBIdx = turns.findIndex((t) => t.role === "user" && t.content === "question B");
    expect(userAIdx).toBeGreaterThanOrEqual(0);
    expect(userBIdx).toBeGreaterThan(userAIdx);
    // Between userA and userB there must be an assistant turn (A's reply).
    const between = roles.slice(userAIdx + 1, userBIdx);
    expect(between).toContain("assistant");
    // And after userB, an assistant turn (B's reply).
    const afterB = roles.slice(userBIdx + 1);
    expect(afterB).toContain("assistant");
  }, 20000);

  test("SC-103: duplicate-session race closed — one session for two first-ever requests", async () => {
    // Two concurrent first-ever requests to eli (no existing session). Before
    // the lock, a read-modify-write race could create two sessions. With
    // withRoomLock serializing, both exchanges append to exactly one session.
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });

    const { provider: provA, release: releaseA, state: stateA } = makeDeferredProvider("mockA");
    const provB: Provider = {
      name: "mockB",
      async query(_req: ProviderRequest): Promise<ProviderResponse> {
        return {
          message: { role: "assistant", content: "reply B" },
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    } as unknown as Provider;
    const providersA = new Map<string, Provider>([["eli", provA]]);
    const providersB = new Map<string, Provider>([["eli", provB]]);

    const reqA = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "first ever A" }),
    });
    const reqB = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "first ever B" }),
    });

    const resA = await handleTalk(reqA, "eli", { roomsDir, providers: providersA });
    const drainA = resA.text();
    for (let i = 0; i < 60 && !stateA.queryStarted; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const resBPromise = handleTalk(reqB, "eli", { roomsDir, providers: providersB });
    await new Promise((r) => setTimeout(r, 100));
    releaseA();
    const resB = await resBPromise;
    await drainA;
    await resB.text();

    // Exactly one session for (eli, ui) — both exchanges landed in it.
    const sessionStore = new SessionStore(sessionsDb);
    const session = sessionStore.getLatestSession("eli", "ui");
    expect(session).not.toBeNull();
    const turns = sessionStore.getTurns(session!.id);
    const userContents = turns.filter((t) => t.role === "user").map((t) => t.content);
    expect(userContents).toContain("first ever A");
    expect(userContents).toContain("first ever B");
    // Count sessions rows for (eli, ui) directly in the SQLite DB. Before the
    // lock, a read-modify-write race could create two sessions; with
    // withRoomLock serializing, exactly one session holds both exchanges.
    const { Database } = await import("bun:sqlite");
    const db = new Database(sessionsDb, { readonly: true });
    const rows = db.query(
      "SELECT COUNT(*) AS n FROM sessions WHERE agent = ? AND channel = ?",
    ).get("eli", "ui") as { n: number };
    db.close();
    expect(rows.n).toBe(1);
  }, 20000);
});
