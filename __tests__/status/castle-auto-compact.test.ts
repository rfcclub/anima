import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTalk } from "../../src/ui/features/town/api/talk";
import { handleCompact } from "../../src/ui/features/town/api/lifecycle";
import { SessionStore } from "../../src/memory/session-store";
import { __resetSharedNarrativeStore } from "../../src/narrative/shared-store";
import { COMPACT_IDLE_MS, SUMMARY_ACK, SUMMARY_MARKER, waitForCastleCompactions } from "../../src/session/castle-compaction";
import { getSharedNarrativeStore } from "../../src/narrative/shared-store";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

// the castle talk path compacts before the turn and pins the summary.
function makeConfig(name: string, roomsDir: string, branching = false): string {
  return [
    "identity:",
    `  name: ${name}`,
    `  label: ${name}`,
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
    ...(branching ? ["contextManagement:", "  mode: branching"] : []),
  ].join("\n");
}

interface Recorded { agent: string; messages: ProviderRequest["messages"] }

function recordingProvider(calls: Recorded[]): Provider {
  return {
    name: "mock",
    async query(req: ProviderRequest): Promise<ProviderResponse> {
      calls.push({ agent: req.agent, messages: structuredClone(req.messages) });
      const content = req.agent === "compactor" ? "SUMMARY OF EARLIER TURNS" : `reply ${calls.length}`;
      return { message: { role: "assistant", content }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  } as unknown as Provider;
}

const contents = (messages: ProviderRequest["messages"]) => messages.map((m) => String(m.content).split(":")[0]);

describe("castle auto-compact", () => {
  let roomsDir: string;
  let stateDir: string;
  let transcriptsDir: string;
  let store: SessionStore;

  beforeEach(() => {
    __resetSharedNarrativeStore();
    process.env.ANIMA_TEST_PROVIDERS = "true";
    roomsDir = mkdtempSync(join(tmpdir(), "anima-compact-rooms-"));
    stateDir = mkdtempSync(join(tmpdir(), "anima-compact-state-"));
    transcriptsDir = mkdtempSync(join(tmpdir(), "anima-compact-transcripts-"));
    process.env.ANIMA_UI_STATE_DIR = stateDir;
    process.env.ANIMA_TRANSCRIPTS_DIR = transcriptsDir;
    store = new SessionStore(join(stateDir, "sessions.db"));
  });

  afterEach(() => {
    __resetSharedNarrativeStore();
    delete process.env.ANIMA_TEST_PROVIDERS;
    delete process.env.ANIMA_UI_STATE_DIR;
    delete process.env.ANIMA_TRANSCRIPTS_DIR;
    rmSync(roomsDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(transcriptsDir, { recursive: true, force: true });
  });

  function room(name: string, branching = false) {
    const dir = join(roomsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), makeConfig(name, roomsDir, branching));
    writeFileSync(join(dir, "AGENTS.md"), `# ${name}`);
    writeFileSync(join(dir, "SOUL.md"), `# ${name} soul`);
    writeFileSync(join(dir, "MEMORY.md"), "");
  }

  /** An open castle session with `count` alternating turns, all `ageMs` old. */
  function seed(name: string, count: number, ageMs: number): string {
    const s = store.createSession(name, "ui");
    store.ensureMainBranch(s.id);
    for (let i = 0; i < count; i++) store.appendTurn(s.id, i % 2 === 0 ? "user" : "assistant", `m${i}: text ${i}`);
    const db = (store as unknown as { db: { run(sql: string, params: unknown[]): void } }).db;
    db.run("UPDATE turns SET ts = ? WHERE session_id = ?", [new Date(Date.now() - ageMs).toISOString(), s.id]);
    return s.id;
  }

  async function talk(name: string, message: string, providers: Map<string, Provider>): Promise<string> {
    const req = new Request(`http://localhost/api/talk/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const res = await handleTalk(req, name, { roomsDir, providers });
    expect(res.status).toBe(200);
    return res.text();
  }

  test("AC-1/AC-2 an idle session starts compacting in the background; that turn does not wait and sends its trimmed history", async () => {
    room("jade");
    const sessionId = seed("jade", 20, COMPACT_IDLE_MS + 60_000);
    const calls: Recorded[] = [];
    await talk("jade", "hello again", new Map([["jade", recordingProvider(calls)]]));

    expect(calls.map((c) => c.agent).sort()).toEqual(["compactor", "jade"]);
    const sent = calls.find((c) => c.agent === "jade")!.messages;
    expect(contents(sent.slice(0, -1))).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
    expect(String(sent.at(-1)!.content)).toContain("hello again");
    await waitForCastleCompactions();
    expect(store.getSummary(sessionId)?.summary).toBe("SUMMARY OF EARLIER TURNS");
    // The ten summarized turns are hidden; the kept tail and this turn's exchange remain.
    expect(store.getTurns(sessionId)).toHaveLength(12);
  }, 20_000);

  test("AC-3/AC-4/AC-13 an immediate second turn makes no summary call and repeats the same summary pair", async () => {
    room("jade");
    seed("jade", 20, COMPACT_IDLE_MS + 60_000);
    const calls: Recorded[] = [];
    const providers = new Map([["jade", recordingProvider(calls)]]);
    await talk("jade", "first", providers);
    await waitForCastleCompactions();
    await talk("jade", "second", providers);
    await talk("jade", "third", providers);

    const turns = calls.filter((c) => c.agent === "jade").map((c) => c.messages);
    expect(calls.filter((c) => c.agent === "compactor")).toHaveLength(1);
    const pair = [
      { role: "user", content: `${SUMMARY_MARKER}\nSUMMARY OF EARLIER TURNS` },
      { role: "assistant", content: SUMMARY_ACK },
    ];
    expect(turns[1]!.slice(0, 2)).toEqual(pair);
    // Summary pair + kept tail (10) + the first turn's two messages + the new message.
    expect(contents(turns[1]!.slice(2, 12))).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 10}`));
    expect(turns[1]).toHaveLength(2 + 10 + 2 + 1);
    expect(String(turns[1]!.at(-1)!.content)).toContain("second");
    // Byte-identical pair on the next turn.
    expect(turns[2]!.slice(0, 2)).toEqual(pair);
  }, 20_000);

  test("AC-10 /compact and the compact HTTP handler compact with reason manual and keep the tail", async () => {
    room("jade");
    const sessionId = seed("jade", 14, 60_000);
    const calls: Recorded[] = [];
    const text = await talk("jade", "/compact", new Map([["jade", recordingProvider(calls)]]));
    expect(text).toContain("summarizing 4");
    await waitForCastleCompactions();
    expect(calls.map((c) => c.agent)).toEqual(["compactor"]);
    expect(store.getTurns(sessionId)).toHaveLength(10);

    room("otto");
    const other = seed("otto", 14, 60_000);
    const res = await handleCompact("otto", { roomsDir, providers: new Map([["otto", recordingProvider([])]]) });
    expect(await res.json()).toEqual({ ok: true, status: "started", summarizing: 4 });
    await waitForCastleCompactions();
    expect(store.getTurns(other)).toHaveLength(10);
    expect(store.getSummary(other)?.summary).toBe("SUMMARY OF EARLIER TURNS");
  }, 20_000);

  async function vnTalk(owner: string, message: string, providers: Map<string, Provider>): Promise<string> {
    const req = new Request(`http://localhost/api/talk/${owner}`, {
      method: "POST",
      headers: { "content-type": "application/json", referer: `http://localhost/rooms/${owner}` },
      body: JSON.stringify({ message }),
    });
    const res = await handleTalk(req, owner, { roomsDir, providers });
    expect(res.status).toBe(200);
    return res.text();
  }

  test("only the speaking agent's session compacts: an empty room or an absent owner's room leaves the owner's session alone", async () => {
    for (const name of ["eli", "bruno"]) room(name);
    const presence = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    presence.seedPlacesFromRoster(["eli", "bruno"]);
    const ownerSession = seed("eli", 20, COMPACT_IDLE_MS + 60_000);
    const eliCalls: Recorded[] = [];
    const brunoCalls: Recorded[] = [];
    const providers = new Map([["eli", recordingProvider(eliCalls)], ["bruno", recordingProvider(brunoCalls)]]);

    // Empty room: narrator only.
    await vnTalk("eli", "anyone here?", providers);
    await waitForCastleCompactions();
    expect(eliCalls).toEqual([]);
    expect(store.getTurns(ownerSession)).toHaveLength(20);

    // Bruno visits Eli's room while Eli is away: Bruno speaks; Eli's session is untouched.
    presence.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 1000 });
    await vnTalk("eli", "hi bruno", providers);
    await waitForCastleCompactions();
    expect(eliCalls).toEqual([]);
    expect(brunoCalls.map((c) => c.agent)).toEqual(["bruno"]);
    expect(store.getTurns(ownerSession)).toHaveLength(20);
    expect(store.getSummary(ownerSession)).toBeNull();
  }, 20_000);

  test("AC-12 a branching room is not compacted", async () => {
    room("jade", true);
    const sessionId = seed("jade", 20, COMPACT_IDLE_MS + 60_000);
    const calls: Recorded[] = [];
    await talk("jade", "hello", new Map([["jade", recordingProvider(calls)]]));
    expect(calls.map((c) => c.agent)).toEqual(["jade"]);
    expect(store.getSummary(sessionId)).toBeNull();
  }, 20_000);
});
