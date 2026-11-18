import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTalk } from "../../src/ui/features/town/api/talk";
import { getSharedNarrativeStore, __resetSharedNarrativeStore } from "../../src/narrative/shared-store";
import { readTranscript } from "../../src/narrative/room-transcript";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

// Transcript directory follows deps.roomsDir. A dev
// server pointed at a test roomsDir used to write prod transcripts to
// ~/.anima/rooms/_shared/transcripts unless the env var was set (SC-106/107).

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

describe("room transcript directory", () => {
  let roomsDir: string;
  let envTranscriptsDir: string;

  beforeEach(() => {
    __resetSharedNarrativeStore();
    process.env.ANIMA_TEST_PROVIDERS = "true";
    roomsDir = mkdtempSync(join(tmpdir(), "anima-tdir-"));
    envTranscriptsDir = mkdtempSync(join(tmpdir(), "anima-envtrans-"));
    process.env.ANIMA_TRANSCRIPTS_DIR = envTranscriptsDir;
    for (const name of ["bruno", "eli", "lena"]) setupRoom(roomsDir, name);
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.seedPlacesFromRoster(["bruno", "eli", "lena"]);
  });

  afterEach(() => {
    __resetSharedNarrativeStore();
    delete process.env.ANIMA_TEST_PROVIDERS;
    delete process.env.ANIMA_TRANSCRIPTS_DIR;
    rmSync(roomsDir, { recursive: true, force: true });
    rmSync(envTranscriptsDir, { recursive: true, force: true });
  });

  test("SC-106: writes land under supplied roomsDir, NOT env var dir", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });

    const providers = new Map<string, Provider>([["eli", mockProvider("mock", "Eli reply.")]]);
    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "hello" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    await res.text(); // drain so the stream start() (which appends the turn) runs

    const roomsDirTranscript = join(roomsDir, "_shared", "transcripts", "eli.jsonl");
    const envDirTranscript = join(envTranscriptsDir, "eli.jsonl");
    expect(existsSync(roomsDirTranscript)).toBe(true);
    expect(existsSync(envDirTranscript)).toBe(false);
  }, 15000);

  test("SC-107: reads use the same directory as writes", async () => {
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });

    const providers = new Map<string, Provider>([["eli", mockProvider("mock", "Eli reply.")]]);
    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify({ message: "persisted question" }),
    });

    const res = await handleTalk(req, "eli", { roomsDir, providers });
    await res.text(); // drain

    const turns = readTranscript("eli", join(roomsDir, "_shared", "transcripts"));
    const userTurns = turns.filter((t) => t.role === "user").map((t) => t.content);
    expect(userTurns).toContain("persisted question");
  }, 15000);
});
