import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTalk } from "../../src/ui/features/town/api/talk";
import { getSharedNarrativeStore, __resetSharedNarrativeStore } from "../../src/narrative/shared-store";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

// Integration tests for the "All" abeleat sequential turn-taking flow
// (owner, then guest).

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

function setupRoom(roomsDir: string, name: string, label: string) {
  const dir = join(roomsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.yaml"), makeConfig(label, roomsDir));
  writeFileSync(join(dir, "AGENTS.md"), `# ${name}`);
  writeFileSync(join(dir, "SOUL.md"), `# ${name} soul`);
  writeFileSync(join(dir, "MEMORY.md"), "");
}

function reassembleAll(text: string): Array<{ agent: string; content: string }> {
  const frames: Array<{ agent: string; content: string }> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const v = line.slice(6);
    try {
      const parsed = JSON.parse(v) as { agent?: string; type?: string; content?: string };
      if (parsed.agent && parsed.type === "text" && parsed.content !== undefined) {
        const last = frames[frames.length - 1];
        if (last && last.agent === parsed.agent) last.content += parsed.content;
        else frames.push({ agent: parsed.agent, content: parsed.content });
      }
    } catch { /* ignore */ }
  }
  return frames;
}

describe("meeting turn-taking — 'All' abeleat flow", () => {
  let roomsDir: string;
  let transcriptsDir: string;

  beforeEach(() => {
    __resetSharedNarrativeStore();
    process.env.ANIMA_TEST_PROVIDERS = "true";
    roomsDir = mkdtempSync(join(tmpdir(), "anima-turntaking-"));
    // Isolate the room transcript writes talk.ts now makes on every VN-surface
    // send — without this, tests append fixture text (mock provider replies)
    // straight into the real ~/.anima/rooms/_shared/transcripts/ files.
    transcriptsDir = mkdtempSync(join(tmpdir(), "anima-transcripts-"));
    process.env.ANIMA_TRANSCRIPTS_DIR = transcriptsDir;
    setupRoom(roomsDir, "eli", "Eli");
    setupRoom(roomsDir, "bruno", "Bruno");
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.seedPlacesFromRoster(["eli", "bruno"]);
  });

  afterEach(() => {
    __resetSharedNarrativeStore();
    delete process.env.ANIMA_TEST_PROVIDERS;
    delete process.env.ANIMA_TRANSCRIPTS_DIR;
    rmSync(roomsDir, { recursive: true, force: true });
    rmSync(transcriptsDir, { recursive: true, force: true });
  });

  test("SC-007: owner beat completes before guest beat, both present, exactly 2 frames in order", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const providers = new Map<string, Provider>([
      ["eli", mockProvider("mock", "Eli's real answer.")],
      ["bruno", mockProvider("mock", "Bruno's addition.")],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "what do you two think?", addressee: "all" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    expect(res.status).toBe(200);
    const text = await res.text();
    const frames = reassembleAll(text);
    expect(frames.length).toBe(2);
    expect(frames[0].agent).toBe("eli");
    expect(frames[0].content).toContain("Eli's real answer.");
    expect(frames[1].agent).toBe("bruno");
    expect(frames[1].content).toContain("Bruno's addition.");
  }, 15000);

  test("SC-012, SC-013: guest receives owner's real answer inside a content-level prompt", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    let capturedGuestMessage = "";
    const providers = new Map<string, Provider>([
      ["eli", mockProvider("mock", "Owner's specific answer XYZ.")],
      ["bruno", {
        name: "mock",
        async query(req: ProviderRequest): Promise<ProviderResponse> {
          const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
          capturedGuestMessage = String(lastUser?.content ?? "");
          return { message: { role: "assistant", content: "sure, adding something" }, usage: { input_tokens: 1, output_tokens: 1 } };
        },
      } as unknown as Provider],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "ask something", addressee: "all" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    await res.text(); // drain the stream so the detached start() body completes
    expect(capturedGuestMessage).toContain("Owner's specific answer XYZ.");
    // SC-211/212: decline instruction is JSON-compatible (names the text field)
    // and quote-free (no quoted "..." sentinel the model could echo).
    expect(capturedGuestMessage).toContain("text");
    expect(capturedGuestMessage).toContain("...");
    expect(capturedGuestMessage).not.toContain('"..."');
    expect(capturedGuestMessage.toLowerCase()).not.toContain("permission");
  }, 15000);

  test("SC-014: guest replies exactly '...' → suppressed, only owner frame present", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const providers = new Map<string, Provider>([
      ["eli", mockProvider("mock", "Owner answers.")],
      ["bruno", mockProvider("mock", "...")],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "hi", addressee: "all" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    const text = await res.text();
    expect(text).not.toContain('"agent":"bruno"');
    const frames = reassembleAll(text);
    expect(frames.length).toBe(1);
    expect(frames[0].agent).toBe("eli");
  }, 15000);

  test("SC-015: guest reply with extra text beyond '...' is treated as a real reply", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const providers = new Map<string, Provider>([
      ["eli", mockProvider("mock", "Owner answers.")],
      ["bruno", mockProvider("mock", "... actually wait, I do have something to say")],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "hi", addressee: "all" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    const text = await res.text();
    expect(text).toContain('"agent":"bruno"');
  }, 15000);

  test("SC-010: owner alone + 'all' → single beat only (degrades to case 1)", async () => {
    setupRoom(roomsDir, "cleo", "Cleo");
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.seedPlacesFromRoster(["cleo"]);
    store.setPresence({ agentId: "cleo", placeId: "chamber_cleo", since: 1000 });

    const providers = new Map<string, Provider>([
      ["cleo", mockProvider("mock", "Cleo alone.")],
    ]);

    const req = new Request("http://localhost/api/talk/cleo", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/cleo" },
      body: JSON.stringify({ message: "hi", addressee: "all" }),
    });

    const res = await handleTalk(req, "cleo", { roomsDir, providers });
    const text = await res.text();
    const frames = reassembleAll(text);
    expect(frames.length).toBe(1);
    expect(frames[0].agent).toBe("cleo");
    expect(frames[0].content).toContain("Cleo alone.");
  }, 15000);

  test("SC-009: empty room + 'all' → narrator frame, zero pipelines", async () => {
    const providers = new Map<string, Provider>([
      ["eli", mockProvider("mock", "Should not be called.")],
    ]);
    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "hi", addressee: "all" }),
    });
    const res = await handleTalk(req, "eli", { roomsDir, providers });
    const text = await res.text();
    expect(text).toContain('"agent":"narrator"');
    expect(text).not.toContain("Should not be called");
  }, 15000);
});

describe("ordered turn-taking — reversible + 3-way", () => {
  let roomsDir: string;
  let transcriptsDir: string;

  beforeEach(() => {
    __resetSharedNarrativeStore();
    process.env.ANIMA_TEST_PROVIDERS = "true";
    roomsDir = mkdtempSync(join(tmpdir(), "anima-ordered-"));
    transcriptsDir = mkdtempSync(join(tmpdir(), "anima-transcripts-"));
    process.env.ANIMA_TRANSCRIPTS_DIR = transcriptsDir;
    setupRoom(roomsDir, "eli", "Eli");
    setupRoom(roomsDir, "bruno", "Bruno");
    setupRoom(roomsDir, "lena", "Lena");
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.seedPlacesFromRoster(["eli", "bruno", "lena"]);
  });

  afterEach(() => {
    __resetSharedNarrativeStore();
    delete process.env.ANIMA_TEST_PROVIDERS;
    delete process.env.ANIMA_TRANSCRIPTS_DIR;
    rmSync(roomsDir, { recursive: true, force: true });
    rmSync(transcriptsDir, { recursive: true, force: true });
  });

  test("owner-then-guest order ('eli,bruno') matches the default 'all' shape", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const providers = new Map<string, Provider>([
      ["eli", mockProvider("mock", "Eli leads.")],
      ["bruno", mockProvider("mock", "Bruno follows.")],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "hi", addressee: "eli,bruno" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    const text = await res.text();
    const frames = reassembleAll(text);
    expect(frames.length).toBe(2);
    expect(frames[0].agent).toBe("eli");
    expect(frames[0].content).toContain("Eli leads.");
    expect(frames[1].agent).toBe("bruno");
    expect(frames[1].content).toContain("Bruno follows.");
  }, 15000);

  test("reversed order ('bruno,eli') — guest leads with a real answer, owner follows", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const providers = new Map<string, Provider>([
      ["eli", mockProvider("mock", "Eli's follow-up.")],
      ["bruno", mockProvider("mock", "Bruno's real answer, leading.")],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "bruno, what do you think?", addressee: "bruno,eli" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    const text = await res.text();
    const frames = reassembleAll(text);
    expect(frames.length).toBe(2);
    expect(frames[0].agent).toBe("bruno");
    expect(frames[0].content).toContain("Bruno's real answer, leading.");
    expect(frames[1].agent).toBe("eli");
    expect(frames[1].content).toContain("Eli's follow-up.");
  }, 15000);

  test("3-way order ('bruno,eli,lena') — leader real, followers see all prior replies, capped at 3", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });
    store.setPresence({ agentId: "lena", placeId: "chamber_eli", since: 3000 });

    let capturedLenaMessage = "";
    const providers = new Map<string, Provider>([
      ["bruno", mockProvider("mock", "Bruno leads with a real answer.")],
      ["eli", mockProvider("mock", "Eli's addition.")],
      ["lena", {
        name: "mock",
        async query(req: ProviderRequest): Promise<ProviderResponse> {
          const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
          capturedLenaMessage = String(lastUser?.content ?? "");
          return { message: { role: "assistant", content: "..." }, usage: { input_tokens: 1, output_tokens: 1 } };
        },
      } as unknown as Provider],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "what do the 3 of you think?", addressee: "bruno,eli,lena" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    const text = await res.text();
    const frames = reassembleAll(text);
    // Lena declined ("..."), so only bruno + eli produce visible frames.
    expect(frames.length).toBe(2);
    expect(frames[0].agent).toBe("bruno");
    expect(frames[1].agent).toBe("eli");
    // Lena's prompt saw BOTH prior replies before declining.
    expect(capturedLenaMessage).toContain("Bruno leads with a real answer.");
    expect(capturedLenaMessage).toContain("Eli's addition.");
  }, 15000);

  test("invalid/stale order falls back to normal single-speaker resolution", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    // "bruno" is NOT present — the order references a stale/absent agent.
    const providers = new Map<string, Provider>([
      ["eli", mockProvider("mock", "Eli alone replies.")],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "hi", addressee: "bruno,eli" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    const text = await res.text();
    const frames = reassembleAll(text);
    expect(frames.length).toBe(1);
    expect(frames[0].agent).toBe("eli");
    expect(frames[0].content).toContain("Eli alone replies.");
  }, 15000);
});

// SC-506..509: pin the exact `message` passed to runStream at each beat. The
// message becomes the last user message in the provider's request, so a
// recording provider captures it.
describe("room-prompt beat inputs (SC-506..509)", () => {
  let roomsDir: string;
  let transcriptsDir: string;

  beforeEach(() => {
    __resetSharedNarrativeStore();
    process.env.ANIMA_TEST_PROVIDERS = "true";
    roomsDir = mkdtempSync(join(tmpdir(), "anima-prompt-"));
    transcriptsDir = mkdtempSync(join(tmpdir(), "anima-transcripts-"));
    process.env.ANIMA_TRANSCRIPTS_DIR = transcriptsDir;
    setupRoom(roomsDir, "eli", "Eli");
    setupRoom(roomsDir, "bruno", "Bruno");
    setupRoom(roomsDir, "lena", "Lena");
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.seedPlacesFromRoster(["eli", "bruno", "lena"]);
  });

  afterEach(() => {
    __resetSharedNarrativeStore();
    delete process.env.ANIMA_TEST_PROVIDERS;
    delete process.env.ANIMA_TRANSCRIPTS_DIR;
    rmSync(roomsDir, { recursive: true, force: true });
    rmSync(transcriptsDir, { recursive: true, force: true });
  });

  function recordingProvider(replyText: string, capture: { msg: string; system: string }) {
    return {
      name: "mock",
      async query(req: ProviderRequest): Promise<ProviderResponse> {
        const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
        capture.msg = String(lastUser?.content ?? "");
        capture.system = String(req.system ?? "");
        return {
          message: { role: "assistant", content: replyText },
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    } as unknown as Provider;
  }

  test("SC-506: beat-1 owner message is the raw user message, not orientation-wrapped", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const ownerCapture = { msg: "", system: "" };
    const providers = new Map<string, Provider>([
      ["eli", recordingProvider("Eli's answer.", ownerCapture)],
      ["bruno", mockProvider("mock", "...")],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "my original question", addressee: "all" }),
    });

    await handleTalk(req, "eli", { roomsDir, providers }).then((r) => r.text());
    // Beat-1 owner message is the RAW user message — the orientation line is
    // for the single-speaker path only, not the multi-beat flows.
    expect(ownerCapture.msg).toBe("my original question");
    // lifecycleContext (presence line) is injected into the system prompt.
    expect(ownerCapture.system).toContain("Bruno");
  }, 15000);

  test("SC-507: beat-2 guest message is the follow-up (user question + owner's spoken text + decline instruction)", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const guestCapture = { msg: "", system: "" };
    const providers = new Map<string, Provider>([
      ["eli", mockProvider("mock", "Eli gives a specific answer ABC.")],
      ["bruno", recordingProvider("Bruno agrees.", guestCapture)],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "what do you two think?", addressee: "all" }),
    });

    await handleTalk(req, "eli", { roomsDir, providers }).then((r) => r.text());
    // Guest message = buildGuestFollowupMessage output: user question + owner's
    // parsed spoken text + JSON-compatible decline instruction.
    expect(guestCapture.msg).toContain("what do you two think?");
    expect(guestCapture.msg).toContain("Eli gives a specific answer ABC.");
    expect(guestCapture.msg).not.toContain("{");
    expect(guestCapture.msg).not.toContain("mood");
  }, 15000);

  test("SC-508: ordered beat-N message carries every prior spoken text in order", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });
    store.setPresence({ agentId: "lena", placeId: "chamber_eli", since: 3000 });

    const lenaCapture = { msg: "", system: "" };
    const providers = new Map<string, Provider>([
      ["bruno", mockProvider("mock", "Bruno says FIRST.")],
      ["eli", mockProvider("mock", "Eli says SECOND.")],
      ["lena", recordingProvider("...", lenaCapture)],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "what do the 3 of you think?", addressee: "bruno,eli,lena" }),
    });

    await handleTalk(req, "eli", { roomsDir, providers }).then((r) => r.text());
    // Lena (beat 3) sees BOTH prior spoken texts, in order.
    expect(lenaCapture.msg).toContain("Bruno says FIRST.");
    expect(lenaCapture.msg).toContain("Eli says SECOND.");
    expect(lenaCapture.msg.indexOf("Bruno says FIRST.")).toBeLessThan(lenaCapture.msg.indexOf("Eli says SECOND."));
    // No raw JSON from prior replies leaks in.
    expect(lenaCapture.msg).not.toContain("{");
    expect(lenaCapture.msg).not.toContain("mood");
  }, 15000);

  test("SC-509: single-speaker VN path wraps the user message in the orientation line", async () => {
    // Case 2: owner + visitor, no "all"/order → single-speaker path. The
    // effectiveMessage is buildOrientationLine output (room + presence + user
    // message), NOT the raw user message.
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const ownerCapture = { msg: "", system: "" };
    const providers = new Map<string, Provider>([
      ["eli", recordingProvider("Eli replies.", ownerCapture)],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "hello eli" }), // no addressee → single-speaker
    });

    await handleTalk(req, "eli", { roomsDir, providers }).then((r) => r.text());
    // The orientation line wraps the user message — so the captured message
    // is NOT the bare "hello eli" but contains room/presence context too.
    expect(ownerCapture.msg).toContain("hello eli");
    // It must be longer than the raw message (orientation wrapping added).
    expect(ownerCapture.msg.length).toBeGreaterThan("hello eli".length);
  }, 15000);
});
