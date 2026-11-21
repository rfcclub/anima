import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LucidDream, MAX_DEEP_DREAM_PROMPT_CHARS } from "./lucid-dream";
import { appendBeamEntries, type BeamEntry } from "./light-nap";
import type { AgentMemoryStore, AgentMemoryEntry } from "../memory/contract";
import type { Provider, ProviderRequest, ProviderResponse } from "../providers/interface";

let roomsDir: string;
let roomDir: string;

beforeEach(() => {
  roomsDir = mkdtempSync(join(tmpdir(), "lucid-dream-"));
  roomDir = join(roomsDir, "lena");
  mkdirSync(roomDir, { recursive: true });
});

afterEach(() => {
  rmSync(roomsDir, { recursive: true, force: true });
});

function makeFakeProvider(responseText: string): Provider {
  return {
    name: "fake" as Provider["name"],
    async query(_req: ProviderRequest): Promise<ProviderResponse> {
      return { message: { role: "assistant", content: responseText } };
    },
  };
}

function makeMemoryStoreSpy(): { store: AgentMemoryStore; calls: Omit<AgentMemoryEntry, "id" | "createdAt">[] } {
  const calls: Omit<AgentMemoryEntry, "id" | "createdAt">[] = [];
  const store: AgentMemoryStore = {
    async remember(entry) {
      calls.push(entry);
      return { ...entry, id: "fake-id", createdAt: new Date().toISOString() };
    },
    async recall() { return []; },
    async bootstrap() { return []; },
    async forget() {},
  };
  return { store, calls };
}

function writeDeepDreamReport(date: string, content: string): void {
  const dreamsDir = join(roomsDir, "staging", "dreams");
  mkdirSync(dreamsDir, { recursive: true });
  writeFileSync(join(dreamsDir, `${date}.md`), content, "utf-8");
}

test("uses the DeepDream report as input when one exists in the last 3 days", async () => {
  writeDeepDreamReport("2026-09-13", "# Dream — 2026-09-13\n\n## lena\n- some cross-referenced insight\n");
  let capturedPrompt = "";
  const spyProvider: Provider = {
    name: "fake" as Provider["name"],
    async query(req: ProviderRequest): Promise<ProviderResponse> {
      capturedPrompt = req.messages[0].content as string;
      return { message: { role: "assistant", content: "reflection text" } };
    },
  };

  const dream = new LucidDream();
  await dream.run({ roomDir, roomsDir, agentName: "lena", provider: spyProvider });

  expect(capturedPrompt).toContain("cross-referenced insight");
  expect(capturedPrompt).toContain("Deep Dream");
});

test("falls back to raw beams when no DeepDream report exists in the last 3 days", async () => {
  const beam: BeamEntry = {
    timestamp: new Date().toISOString(),
    agent: "lena",
    session: "pulse:test",
    keywords: ["insight"],
    source: "pulse-anima:test",
    content: "raw beam content nobody cross-referenced yet",
  };
  await appendBeamEntries(roomDir, [beam]);

  let capturedPrompt = "";
  const spyProvider: Provider = {
    name: "fake" as Provider["name"],
    async query(req) {
      capturedPrompt = req.messages[0].content as string;
      return { message: { role: "assistant", content: "reflection text" } };
    },
  };

  const dream = new LucidDream();
  await dream.run({ roomDir, roomsDir, agentName: "lena", provider: spyProvider });

  expect(capturedPrompt).toContain("raw beam content nobody cross-referenced yet");
});

test("persists the LLM reflection directly via AgentMemoryStore.remember when a memoryStore is provided", async () => {
  const { store, calls } = makeMemoryStoreSpy();
  const dream = new LucidDream();

  await dream.run({
    roomDir,
    roomsDir,
    agentName: "lena",
    provider: makeFakeProvider("a genuine reflection"),
    memoryStore: store,
  });

  expect(calls).toHaveLength(1);
  expect(calls[0].content).toBe("a genuine reflection");
  expect(calls[0].source).toBe("lucid-dream");
});

test("does not throw and does not write memory when memoryStore is omitted", async () => {
  const dream = new LucidDream();
  const result = await dream.run({
    roomDir,
    roomsDir,
    agentName: "lena",
    provider: makeFakeProvider("a reflection with no memory store"),
  });
  expect(result.response).toBe("a reflection with no memory store");
});

test("keeps only the 5 most recent lucid-*.md files, deleting the oldest on overflow", async () => {
  const { readdirSync } = await import("node:fs");
  const dreamsDir = join(roomDir, "staging", "dreams");
  mkdirSync(dreamsDir, { recursive: true });

  // Seed 5 pre-existing lucid dream files, oldest to newest.
  const seedTimestamps = [
    "2026-09-01T0000",
    "2026-09-02T0000",
    "2026-09-03T0000",
    "2026-09-04T0000",
    "2026-09-05T0000",
  ];
  for (const ts of seedTimestamps) {
    writeFileSync(join(dreamsDir, `lucid-${ts}.md`), "# old\n", "utf-8");
  }

  const dream = new LucidDream();
  await dream.run({ roomDir, roomsDir, agentName: "lena", provider: makeFakeProvider("newest reflection") });

  const files = readdirSync(dreamsDir).filter((f) => f.startsWith("lucid-")).sort();
  expect(files).toHaveLength(5);
  expect(files).not.toContain("lucid-2026-09-01T0000.md");
  expect(files).toContain("lucid-2026-09-02T0000.md");
});

// A DeepDream report holds one section per agent and one entry per pulse
// output. Real reports reached 4 MB each; three of them in one prompt is
// ~13 MB, which no model accepts. The prompt must stay bounded no matter
// how large the reports are, and every agent's section must keep a share.
function makeHugeReport(date: string, agents: string[], entriesPerAgent: number): string {
  const lines = [`# Dream — ${date}`, ""];
  for (const agent of agents) {
    lines.push(`## ${agent}`);
    for (let i = 0; i < entriesPerAgent; i++) {
      const stamp = `2026-11-20T21:09:${String(59 - (i % 60)).padStart(2, "0")}.000Z`;
      lines.push(`- [${stamp}] ${agent}-entry-${i} ${"x".repeat(5_000)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

test("keeps the prompt bounded when the DeepDream reports are huge", async () => {
  const agents = ["lena", "mira", "otto", "pia"];
  writeDeepDreamReport("2026-11-19", makeHugeReport("2026-11-19", agents, 200));
  writeDeepDreamReport("2026-11-20", makeHugeReport("2026-11-20", agents, 200));
  writeDeepDreamReport("2026-11-21", makeHugeReport("2026-11-21", agents, 200));
  let capturedPrompt = "";
  const spyProvider: Provider = {
    name: "fake" as Provider["name"],
    async query(req: ProviderRequest): Promise<ProviderResponse> {
      capturedPrompt = req.messages[0].content as string;
      return { message: { role: "assistant", content: "ok" } };
    },
  };

  await new LucidDream().run({ roomDir, roomsDir, agentName: "lena", provider: spyProvider });

  expect(capturedPrompt.length).toBeLessThanOrEqual(MAX_DEEP_DREAM_PROMPT_CHARS + 4_000);
  // each agent still has a section, and the newest entry of each survives
  for (const agent of agents) {
    expect(capturedPrompt).toContain(`## ${agent}`);
    expect(capturedPrompt).toContain(`${agent}-entry-0 `);
  }
  // the cut is visible, not silent
  expect(capturedPrompt).toContain("omitted");
});

test("leaves a small DeepDream report untouched", async () => {
  const small = "# Dream — 2026-09-13\n\n## lena\n- [2026-09-13T01:00:00.000Z] short insight\n- [2026-09-13T00:59:00.000Z] another\n";
  writeDeepDreamReport("2026-09-13", small);
  let capturedPrompt = "";
  const spyProvider: Provider = {
    name: "fake" as Provider["name"],
    async query(req: ProviderRequest): Promise<ProviderResponse> {
      capturedPrompt = req.messages[0].content as string;
      return { message: { role: "assistant", content: "ok" } };
    },
  };

  await new LucidDream().run({ roomDir, roomsDir, agentName: "lena", provider: spyProvider });

  expect(capturedPrompt).toContain(small);
  expect(capturedPrompt).not.toContain("omitted");
});
