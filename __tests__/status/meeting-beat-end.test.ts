import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTalk } from "../../src/ui/features/town/api/talk";
import { getSharedNarrativeStore, __resetSharedNarrativeStore } from "../../src/narrative/shared-store";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

// room-beat-streaming: each beat ends with a `beat_end` frame, written before
// the next speaker's provider call starts, so the castle can show a finished
// answer while the next one is still being generated.

function makeConfig(label: string, roomsDir: string): string {
  const name = label.toLowerCase();
  return [
    "identity:", `  name: ${name}`, `  label: ${label}`, "  identityAnchor: test",
    "boot:", "  gene: AGENTS.md", "  soul: SOUL.md", "  sessionContext:", "  - MEMORY.md",
    "memory:", "  store: jsonl",
    "session:", "  defaultMode: plan", "  compactThreshold: 50",
    "provider:", "  type: mock", "  model: mock-model",
    "policy:", "  allowedRoots:", `  - ${join(roomsDir, name)}`,
    "reflection:", "  enabled: false",
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

function reply(text: string): Provider {
  return {
    name: "mock",
    async query(_req: ProviderRequest): Promise<ProviderResponse> {
      return { message: { role: "assistant", content: text }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  } as unknown as Provider;
}

/** A provider that answers only after the test releases it. */
function gated(text: string): { provider: Provider; release: () => void; called: Promise<void> } {
  let release!: () => void;
  let markCalled!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const called = new Promise<void>((resolve) => { markCalled = resolve; });
  const provider = {
    name: "mock",
    async query(_req: ProviderRequest): Promise<ProviderResponse> {
      markCalled();
      await gate;
      return { message: { role: "assistant", content: text }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  } as unknown as Provider;
  return { provider, release, called };
}

type Frame = { agent?: string; type?: string; content?: string };

/** Reads frames as they arrive until `until` returns true. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, seen: Frame[], until: (f: Frame[]) => boolean): Promise<void> {
  const dec = new TextDecoder();
  let buf = "";
  while (!until(seen)) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: {")) continue;
      try { seen.push(JSON.parse(line.slice(6)) as Frame); } catch { /* ignore */ }
    }
  }
}

describe("room-beat-streaming: beat_end frames", () => {
  let roomsDir: string;
  let transcriptsDir: string;

  beforeEach(() => {
    __resetSharedNarrativeStore();
    process.env.ANIMA_TEST_PROVIDERS = "true";
    roomsDir = mkdtempSync(join(tmpdir(), "anima-beat-end-"));
    transcriptsDir = mkdtempSync(join(tmpdir(), "anima-transcripts-"));
    process.env.ANIMA_TRANSCRIPTS_DIR = transcriptsDir;
    setupRoom(roomsDir, "eli", "Eli");
    setupRoom(roomsDir, "bruno", "Bruno");
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.seedPlacesFromRoster(["eli", "bruno"]);
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });
  });

  afterEach(() => {
    __resetSharedNarrativeStore();
    delete process.env.ANIMA_TEST_PROVIDERS;
    delete process.env.ANIMA_TRANSCRIPTS_DIR;
    rmSync(roomsDir, { recursive: true, force: true });
    rmSync(transcriptsDir, { recursive: true, force: true });
  });

  for (const addressee of ["all", "eli,bruno"]) {
    test(`addressee "${addressee}": the owner's beat_end reaches the client while the guest is still answering`, async () => {
      const guest = gated("Bruno's addition.");
      const providers = new Map<string, Provider>([["eli", reply("Eli's answer.")], ["bruno", guest.provider]]);
      const req = new Request("http://localhost/api/talk/eli", {
        method: "POST",
        headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
        body: JSON.stringify({ message: "what do you two think?", addressee }),
      });
      const res = await handleTalk(req, "eli", { roomsDir, providers });
      const reader = res.body!.getReader();
      const seen: Frame[] = [];

      await readUntil(reader, seen, (f) => f.some((x) => x.type === "beat_end"));
      await guest.called;
      // The guest has not answered yet: only the owner's beat is on the wire, and it is closed.
      expect(seen.filter((f) => f.type === "text").every((f) => f.agent === "eli")).toBe(true);
      expect(seen.filter((f) => f.type === "text").map((f) => f.content).join("")).toContain("Eli's answer.");
      expect(seen.at(-1)).toEqual({ agent: "eli", type: "beat_end" });

      guest.release();
      await readUntil(reader, seen, () => false);
      const ends = seen.filter((f) => f.type === "beat_end").map((f) => f.agent);
      expect(ends).toEqual(["eli", "bruno"]);
      expect(seen.findIndex((f) => f.agent === "bruno" && f.type === "text")).toBeGreaterThan(seen.findIndex((f) => f.type === "beat_end"));
    }, 15000);
  }
});
