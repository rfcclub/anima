import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTalk } from "../../src/ui/features/town/api/talk";
import { getHideThink, setHideThink } from "../../src/ui/utils/sse";
import { getSharedNarrativeStore, __resetSharedNarrativeStore } from "../../src/narrative/shared-store";
import { readTranscript } from "../../src/narrative/room-transcript";
import { SessionStore } from "../../src/memory/session-store";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

// Multi-beat stream resilience. The single-speaker path
// already had try/finally + [DONE]; runAllBeats/runOrderedBeats did not — a
// mid-beat provider throw lost the user's message and left no [DONE].

function throwingProvider(name: string): Provider {
  return {
    name,
    async query(_req: ProviderRequest): Promise<ProviderResponse> {
      throw new Error("provider-boom");
    },
  } as unknown as Provider;
}

function mockProvider(name: string, replyText: string): Provider {
  return {
    name,
    async query(_req: ProviderRequest): Promise<ProviderResponse> {
      return {
        message: { role: "assistant", content: replyText },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  } as unknown as Provider;
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

function parseFrames(text: string): { errors: string[]; done: boolean; agentTexts: Record<string, string> } {
  const errors: string[] = [];
  let done = false;
  const agentTexts: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const v = line.slice(6);
    if (v === "[DONE]") { done = true; continue; }
    if (v.startsWith("{")) {
      try {
        const f = JSON.parse(v) as { error?: string; agent?: string; type?: string; content?: string };
        if (f.error) errors.push(f.error);
        else if (f.agent && f.type === "text" && f.content) {
          agentTexts[f.agent] = (agentTexts[f.agent] ?? "") + f.content;
        }
      } catch { /* ignore */ }
    }
  }
  return { errors, done, agentTexts };
}

describe("multi-beat stream resilience", () => {
  let roomsDir: string;
  let transcriptsDir: string;
  let sessionsDb: string;

  beforeEach(() => {
    __resetSharedNarrativeStore();
    process.env.ANIMA_TEST_PROVIDERS = "true";
    roomsDir = mkdtempSync(join(tmpdir(), "anima-resil-"));
    transcriptsDir = mkdtempSync(join(tmpdir(), "anima-trans-"));
    // talk.ts's getSessionStore() resolves the session DB to
    // defaultStateDir()/sessions.db, which honors ANIMA_UI_STATE_DIR (not
    // ANIMA_SESSIONS_DB). Point it at the temp rooms dir so we can read
    // session turns back in the test.
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

  test("SC-401: beat-1 failure in runAllBeats sends error frame + [DONE]", async () => {
    // eli owner + bruno guest. Owner provider throws in beat 1.
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const providers = new Map<string, Provider>([
      ["eli", throwingProvider("mock")],
      ["bruno", mockProvider("mock", "Bruno reply.")],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "what do you all think?", addressee: "all" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    const text = await res.text();
    const { errors, done } = parseFrames(text);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toContain("provider-boom");
    expect(done).toBe(true);
  }, 15000);

  test("SC-404: user message survives a beat-1 failure (up-front persist)", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const providers = new Map<string, Provider>([
      ["eli", throwingProvider("mock")],
      ["bruno", mockProvider("mock", "Bruno reply.")],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "important question", addressee: "all" }),
    });

    await handleTalk(req, "eli", { roomsDir, providers });
    const turns = readTranscript("eli", join(roomsDir, "_shared", "transcripts"));
    const userTurns = turns.filter((t) => t.role === "user");
    expect(userTurns.length).toBeGreaterThanOrEqual(1);
    expect(userTurns[0].content).toBe("important question");
  }, 15000);

  test("SC-402 + SC-405: mid-sequence failure in ordered sends error + [DONE], beat-1 stays persisted", async () => {
    // Ordered: eli leads (succeeds), bruno follows (throws).
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const providers = new Map<string, Provider>([
      ["eli", mockProvider("mock", "Eli beat-1 reply.")],
      ["bruno", throwingProvider("mock")],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "what do you all think?", addressee: "eli,bruno" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    const text = await res.text();
    const { errors, done, agentTexts } = parseFrames(text);
    // beat-1 (eli) text was emitted before the failure
    expect(agentTexts.eli).toContain("Eli beat-1 reply.");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(done).toBe(true);
    // beat-1 stays persisted in the room transcript
    const turns = readTranscript("eli", join(roomsDir, "_shared", "transcripts"));
    const eliAssistant = turns.filter((t) => t.speaker === "eli" && t.role === "assistant");
    expect(eliAssistant.length).toBeGreaterThanOrEqual(1);
  }, 15000);

  test("SC-403: successful multi-beat run is unchanged (no error frame, [DONE] sent)", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const providers = new Map<string, Provider>([
      ["eli", mockProvider("mock", "Eli reply.")],
      ["bruno", mockProvider("mock", "Bruno reply.")],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "what do you all think?", addressee: "all" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    const text = await res.text();
    const { errors, done, agentTexts } = parseFrames(text);
    expect(errors).toEqual([]);
    expect(done).toBe(true);
    expect(agentTexts.eli).toContain("Eli reply.");
    expect(agentTexts.bruno).toContain("Bruno reply.");
  }, 15000);

  test("SC-407 + SC-408: hideThink captured per-request, mid-sequence toggle ignored", async () => {
    // Start with hideThink=true. Owner reply contains a think tag that must be
    // stripped. Between beat 1 and beat 2 the global is toggled to false — but
    // the captured value (true) must govern both beats. A new request after the
    // toggle captures false.
    setHideThink(true);
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const eliProvider: Provider = {
      name: "mock",
      async query(_req: ProviderRequest): Promise<ProviderResponse> {
        return {
          message: { role: "assistant", content: "<think>internal</think>Eli reply." },
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    } as unknown as Provider;
    const brunoProvider: Provider = {
      name: "mock",
      async query(_req: ProviderRequest): Promise<ProviderResponse> {
        // Toggle the global mid-sequence (after beat 1, before/during beat 2).
        setHideThink(false);
        return {
          message: { role: "assistant", content: "<think>internal</think>Bruno reply." },
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    } as unknown as Provider;

    const providers = new Map<string, Provider>([
      ["eli", eliProvider],
      ["bruno", brunoProvider],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "what do you all think?", addressee: "all" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    const text = await res.text();
    const { agentTexts } = parseFrames(text);
    // Both beats used the captured hideThink=true → think tags stripped from both.
    // If the code re-read the global per beat, bruno's beat would NOT strip (toggled
    // false) and the think tag would leak into the frame.
    expect(agentTexts.eli).toContain("Eli reply.");
    expect(agentTexts.eli).not.toContain("internal");
    expect(agentTexts.bruno).toContain("Bruno reply.");
    expect(agentTexts.bruno).not.toContain("internal");
    // The global was toggled to false mid-run — a NEW request now captures false
    expect(getHideThink()).toBe(false);
    setHideThink(true); // restore for other tests
  }, 15000);

  test("SC-406: failed beat leaves no orphan session user turn", async () => {
    // Ordered: eli leads (succeeds), bruno follows (throws before any reply).
    // The follow-up prompt for bruno is built and her session is opened, but
    // because the provider throws, loop.ts returns before the
    // appendTurn(user)+appendTurn(assistant) pair (loop.ts:135-136). So bruno's
    // session must NOT contain a user turn without a matching assistant turn.
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const providers = new Map<string, Provider>([
      ["eli", mockProvider("mock", "Eli beat-1 reply.")],
      ["bruno", throwingProvider("mock")],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "what do you all think?", addressee: "eli,bruno" }),
    });

    await handleTalk(req, "eli", { roomsDir, providers });

    // Read bruno's session turns directly from the session DB.
    const sessionStore = new SessionStore(sessionsDb);
    const brunoSession = sessionStore.getLatestSession("bruno", "ui");
    if (brunoSession) {
      const turns = sessionStore.getTurns(brunoSession.id);
      const userTurns = turns.filter((t) => t.role === "user");
      const assistantTurns = turns.filter((t) => t.role === "assistant");
      // No orphan: every user turn has a following assistant turn. If the
      // follow-up prompt had been appended before the throw, bruno's session
      // would hold a lone user turn with no assistant reply.
      expect(userTurns.length).toBe(assistantTurns.length);
    }
    // eli's session is intact (beat-1 succeeded → user+assistant pair).
    const eliSession = sessionStore.getLatestSession("eli", "ui");
    expect(eliSession).not.toBeNull();
    const eliTurns = sessionStore.getTurns(eliSession!.id);
    const eliUser = eliTurns.filter((t) => t.role === "user").length;
    const eliAssistant = eliTurns.filter((t) => t.role === "assistant").length;
    expect(eliUser).toBe(eliAssistant);
  }, 15000);
});
