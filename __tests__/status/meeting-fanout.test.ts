import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTalk } from "../../src/ui/features/town/api/talk";
import { getSharedNarrativeStore, __resetSharedNarrativeStore } from "../../src/narrative/shared-store";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

// Integration tests for the sequential speaker protocol (Fable rework).
// One user message → one speaker, resolved from presence. No parallel
// fan-out. The absent owner's pipeline never runs (case 5).

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
  writeFileSync(join(dir, "config.yaml"), makeConfig(name === "bruno" ? "Bruno" : name === "eli" ? "Eli" : name === "lena" ? "Lena" : name, roomsDir));
  writeFileSync(join(dir, "AGENTS.md"), `# ${name}`);
  writeFileSync(join(dir, "SOUL.md"), `# ${name} soul`);
  writeFileSync(join(dir, "MEMORY.md"), "");
}

function reassemble(text: string): string {
  return text
    .split("\n")
    .filter((l) => l.startsWith('data: "') || l.startsWith('data: {'))
    .map((l) => l.slice(6))
    .map((v) => (v.startsWith('"') || v.startsWith('{') ? JSON.parse(v) : v))
    .map((v) => (typeof v === "string" ? v : (v as { content?: string }).content ?? ""))
    .join("");
}

describe("sequential speaker protocol (Fable rework)", () => {
  let roomsDir: string;
  let transcriptsDir: string;

  beforeEach(() => {
    __resetSharedNarrativeStore();
    process.env.ANIMA_TEST_PROVIDERS = "true";
    roomsDir = mkdtempSync(join(tmpdir(), "anima-speaker-"));
    // Isolate room-transcript writes (talk.ts writes on every VN-surface
    // send) from the real ~/.anima/rooms/_shared/transcripts/ files.
    transcriptsDir = mkdtempSync(join(tmpdir(), "anima-transcripts-"));
    process.env.ANIMA_TRANSCRIPTS_DIR = transcriptsDir;
    for (const name of ["bruno", "eli", "lena"]) setupRoom(roomsDir, name);
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.seedPlacesFromRoster(["bruno", "eli", "lena"]);
  });

  afterEach(() => {
    __resetSharedNarrativeStore();
    delete process.env.ANIMA_TEST_PROVIDERS;
    delete process.env.ANIMA_TRANSCRIPTS_DIR;
    rmSync(roomsDir, { recursive: true, force: true });
    rmSync(transcriptsDir, { recursive: true, force: true });
  });

  test("case 2 meeting: one primary speaker, no parallel frames", async () => {
    // Both bruno + eli in eli's room. User asks openly → owner (eli) speaks.
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const providers = new Map<string, Provider>([
      ["bruno", mockProvider("mock", "Bruno should NOT reply in parallel.")],
      ["eli", mockProvider("mock", "Eli primary reply.")],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "what are you two doing?" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    expect(res.status).toBe(200);
    const text = await res.text();
    // Exactly one speaker — no parallel bruno frames.
    expect(text).not.toContain('"agent":"bruno"');
    // Eli's reply present (single-agent path, word-chunked).
    expect(reassemble(text)).toContain("Eli primary reply.");
  }, 15000);

  test("case 2 meeting: naming the visitor by name switches the speaker, tagged correctly", async () => {
    // Both bruno + eli in eli's room. User names bruno explicitly → bruno
    // speaks (not the default owner), and the SSE frames are tagged with
    // the actual speaker so the client renders the right nameplate.
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });

    const providers = new Map<string, Provider>([
      ["bruno", mockProvider("mock", "Bruno addressed reply.")],
      ["eli", mockProvider("mock", "Eli should NOT reply here.")],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "Bruno \u01a1i, what do you think?" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    expect(res.status).toBe(200);
    const text = await res.text();
    // Frames are tagged with the resolved speaker (bruno), not the room owner.
    expect(text).toContain('"agent":"bruno"');
    expect(text).not.toContain('"agent":"eli"');
    expect(reassemble(text)).toContain("Bruno addressed reply.");
    expect(reassemble(text)).not.toContain("Eli should NOT reply here.");
  }, 15000);

  test("case 5: owner away + visitor → visitor speaks, owner never loaded", async () => {
    // bruno's room has only lena (bruno is away in eli's room).
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "lena", placeId: "chamber_bruno", since: 2000 });

    const providers = new Map<string, Provider>([
      ["bruno", mockProvider("mock", "Bruno should NOT reply — she is away.")],
      ["lena", mockProvider("mock", "Lena visitor reply.")],
    ]);

    const req = new Request("http://localhost/api/talk/bruno", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/bruno" },
      body: JSON.stringify({ message: "are you here alone?" }),
    });

    const res = await handleTalk(req, "bruno", { roomsDir, providers });
    expect(res.status).toBe(200);
    const text = await res.text();
    // Lena replies, not bruno — and frames are tagged "lena", not the room
    // owner "bruno" (the RoomScreen bubble nameplate reads this tag).
    expect(text).toContain('"agent":"lena"');
    expect(text).not.toContain('"agent":"bruno"');
    expect(reassemble(text)).toContain("Lena visitor reply.");
    expect(reassemble(text)).not.toContain("Bruno should NOT reply");
  }, 15000);

  test("case 4: empty room → narrator frame, zero pipelines", async () => {
    // No one in bruno's room.
    const providers = new Map<string, Provider>([
      ["bruno", mockProvider("mock", "Bruno should NOT be called.")],
    ]);

    const req = new Request("http://localhost/api/talk/bruno", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/bruno" },
      body: JSON.stringify({ message: "hello?" }),
    });

    const res = await handleTalk(req, "bruno", { roomsDir, providers });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"agent":"narrator"');
    expect(text).toContain("The chamber is empty.");
    expect(text).toContain("[DONE]");
    // No agent pipeline ran.
    expect(reassemble(text)).not.toContain("Bruno should NOT be called");
  }, 15000);

  test("case 1: owner alone → owner replies (single-agent path)", async () => {
    setupRoom(roomsDir, "cleo");
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.seedPlacesFromRoster(["cleo"]);
    store.setPresence({ agentId: "cleo", placeId: "chamber_cleo", since: 1000 });

    const providers = new Map<string, Provider>([
      ["cleo", mockProvider("mock", "Cleo alone reply.")],
    ]);

    const req = new Request("http://localhost/api/talk/cleo", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/cleo" },
      body: JSON.stringify({ message: "hi cleo" }),
    });

    const res = await handleTalk(req, "cleo", { roomsDir, providers });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(reassemble(text)).toContain("Cleo alone reply.");
  }, 15000);

  test("case 1: LLM receives the room-orientation intro, not the raw message", async () => {
    setupRoom(roomsDir, "cleo");
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.seedPlacesFromRoster(["cleo"]);
    store.setPresence({ agentId: "cleo", placeId: "chamber_cleo", since: 1000 });

    let capturedMessage = "";
    const providers = new Map<string, Provider>([
      ["cleo", {
        name: "mock",
        async query(req: ProviderRequest): Promise<ProviderResponse> {
          const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
          capturedMessage = String(lastUser?.content ?? "");
          return { message: { role: "assistant", content: "ok" }, usage: { input_tokens: 1, output_tokens: 1 } };
        },
      } as unknown as Provider],
    ]);

    const req = new Request("http://localhost/api/talk/cleo", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/cleo" },
      body: JSON.stringify({ message: "hi cleo" }),
    });

    const res = await handleTalk(req, "cleo", { roomsDir, providers });
    await res.text();
    expect(capturedMessage).toContain("In Cleo's room");
    expect(capturedMessage).toContain("there are Cleo and the user");
    expect(capturedMessage).toContain("hi cleo");
  }, 15000);

  test("case 5: LLM receives the room-orientation intro naming the visitor, owner marked absent", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "lena", placeId: "chamber_bruno", since: 2000 });

    let capturedMessage = "";
    const providers = new Map<string, Provider>([
      // "bruno" is required even though case 5 guarantees her pipeline never
      // actually runs — the top-of-handleTalk provider resolution for the
      // URL's agentName happens before speaker resolution reloads to lena.
      ["bruno", mockProvider("mock", "Bruno should NOT be called.")],
      ["lena", {
        name: "mock",
        async query(req: ProviderRequest): Promise<ProviderResponse> {
          const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
          capturedMessage = String(lastUser?.content ?? "");
          return { message: { role: "assistant", content: "ok" }, usage: { input_tokens: 1, output_tokens: 1 } };
        },
      } as unknown as Provider],
    ]);

    const req = new Request("http://localhost/api/talk/bruno", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/bruno" },
      body: JSON.stringify({ message: "are you here alone?" }),
    });

    const res = await handleTalk(req, "bruno", { roomsDir, providers });
    await res.text();
    expect(capturedMessage).toContain("Bruno is not in the room");
    expect(capturedMessage).toContain("there are Lena and the user");
    expect(capturedMessage).toContain("are you here alone?");
  }, 15000);

  test("mock leak gate: prod (flag unset) ignores injected providers", async () => {
    // Without ANIMA_TEST_PROVIDERS, deps.providers must be ignored — the
    // provider comes from resolveAgentProvider (config). An injected mock
    // that returns "LEAK" must NOT appear in the reply.
    delete process.env.ANIMA_TEST_PROVIDERS;
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });

    const providers = new Map<string, Provider>([
      ["eli", mockProvider("mock", "LEAK — injected provider used in prod!")],
    ]);

    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "hi" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    const text = await res.text();
    // The injected mock text must NOT leak — provider came from config.
    expect(text).not.toContain("LEAK");
  }, 15000);
});
