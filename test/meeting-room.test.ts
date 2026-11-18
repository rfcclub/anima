import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MeetingRoom } from "../src/meeting/room";
import type { LoadedAgent } from "../src/agents/loader";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/interface";

/* ------------------------------------------------------------------ */
/*  MockProvider — counts calls, captures prompts, returns canned      */
/* ------------------------------------------------------------------ */

class MockProvider implements Provider {
  readonly name = "gemini" as const;
  callCount = 0;
  capturedSystemPrompts: string[] = [];
  capturedMessages: string[] = [];

  constructor(private canned: string = "mock response") {}

  async query(req: ProviderRequest): Promise<ProviderResponse> {
    this.callCount++;
    this.capturedSystemPrompts.push(req.system ?? "");
    const text = typeof req.messages[0]?.content === "string"
      ? req.messages[0].content
      : "";
    this.capturedMessages.push(text);
    return {
      message: { role: "assistant", content: this.canned },
    };
  }

  reset(): void {
    this.callCount = 0;
    this.capturedSystemPrompts = [];
    this.capturedMessages = [];
  }
}

/* ------------------------------------------------------------------ */
/*  Helper: build LoadedAgent objects (mirrors session.test.ts)        */
/* ------------------------------------------------------------------ */

function makeAgent(
  name: string,
  label: string,
  tempDir: string,
  overrides?: { soulContent?: string },
): LoadedAgent {
  return {
    name,
    label,
    roomDir: join(tempDir, "rooms", name),
    soulPath: "PREFACE.md",
    geneContent: "Core instructions.",
    soulContent: overrides?.soulContent ?? `You are ${name}.`,
    sessionContextFiles: [{ path: "AGENTS.md", content: "Session context." }],
    additionalContent: [],
    config: {
      identity: { name, label },
      provider: { type: "gemini", model: "gemini-2.0-flash" },
      policy: {
        allowedRoots: [join(tempDir, "rooms", name, "staging")],
        readOnlyRoots: [join(tempDir, "rooms", name, "mount")],
      },
      session: {
        defaultMode: "plan",
        autoModeOptIn: false,
        compactThreshold: 60000,
      },
      boot: { gene: "PREFACE.md", soul: "PREFACE.md", sessionContext: [{ path: "AGENTS.md" }] },
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Test suite                                                        */
/* ------------------------------------------------------------------ */

let tempDir: string;
let mockProvider: MockProvider;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "anima-meeting-"));
  mockProvider = new MockProvider();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/* ---------- Transcript file creation with proper header ---------- */

test("creates transcript file with header for new meeting", async () => {
  const room = new MeetingRoom({ roomsDir: tempDir, provider: mockProvider });
  const agents = [makeAgent("bruno", "Bruno", tempDir), makeAgent("eli", "Eli", tempDir)];

  await room.runWithAgents(agents, "test-topic", { turns: 1 });

  const today = new Date().toISOString().slice(0, 10);
  const transcriptPath = join(tempDir, "_meeting", "test-topic", `${today}.md`);
  expect(existsSync(transcriptPath)).toBe(true);

  const content = readFileSync(transcriptPath, "utf-8");
  expect(content).toContain("# Meeting: test-topic");
  expect(content).toContain(`Date: ${today}`);
  expect(content).toContain("Participants: bruno, eli");
});

/* ---------- Provider call count ---------- */

test("makes correct number of provider calls (2 agents x 1 turn = 2)", async () => {
  const room = new MeetingRoom({ roomsDir: tempDir, provider: mockProvider });
  const agents = [makeAgent("bruno", "Bruno", tempDir), makeAgent("eli", "Eli", tempDir)];

  await room.runWithAgents(agents, "count-test", { turns: 1 });

  expect(mockProvider.callCount).toBe(2);
});

test("makes correct number of provider calls (2 agents x 3 turns = 6)", async () => {
  const room = new MeetingRoom({ roomsDir: tempDir, provider: mockProvider });
  const agents = [makeAgent("bruno", "Bruno", tempDir), makeAgent("eli", "Eli", tempDir)];

  await room.runWithAgents(agents, "count-test-2", { turns: 3 });

  expect(mockProvider.callCount).toBe(6);
});

/* ---------- Resume behavior ---------- */

test("resume appends to existing transcript with resume marker", async () => {
  const room = new MeetingRoom({ roomsDir: tempDir, provider: mockProvider });
  const agents = [makeAgent("bruno", "Bruno", tempDir)];
  const today = new Date().toISOString().slice(0, 10);

  // First run
  await room.runWithAgents(agents, "resume-topic", { turns: 1 });

  // Read initial content length
  const transcriptPath = join(tempDir, "_meeting", "resume-topic", `${today}.md`);
  const initialContent = readFileSync(transcriptPath, "utf-8");
  expect(initialContent).not.toContain("Resumed at");

  // Second run with resume=true
  mockProvider.reset();
  await room.runWithAgents(agents, "resume-topic", { turns: 1, resume: true });

  const resumedContent = readFileSync(transcriptPath, "utf-8");
  expect(resumedContent).toContain("Resumed at");
  expect(resumedContent.startsWith(initialContent.trimEnd())).toBe(true);
});

test("resume creates new file when no today's file exists", async () => {
  const room = new MeetingRoom({ roomsDir: tempDir, provider: mockProvider });
  const agents = [makeAgent("bruno", "Bruno", tempDir)];
  const today = new Date().toISOString().slice(0, 10);

  // No prior transcript — resume should create fresh
  await room.runWithAgents(agents, "fresh-resume", { turns: 1, resume: true });

  const transcriptPath = join(tempDir, "_meeting", "fresh-resume", `${today}.md`);
  expect(existsSync(transcriptPath)).toBe(true);

  const content = readFileSync(transcriptPath, "utf-8");
  expect(content).toContain("# Meeting: fresh-resume");
  expect(content).not.toContain("Resumed at");
});

/* ---------- Inject directive ---------- */

test("inject directive appears in every agent's system prompt", async () => {
  const room = new MeetingRoom({ roomsDir: tempDir, provider: mockProvider });
  const agents = [makeAgent("bruno", "Bruno", tempDir), makeAgent("eli", "Eli", tempDir)];

  await room.runWithAgents(agents, "inject-test", { turns: 1, inject: "focus on performance" });

  for (const prompt of mockProvider.capturedSystemPrompts) {
    expect(prompt).toContain("## Meeting Directive");
    expect(prompt).toContain("focus on performance");
  }
});

/* ---------- Turn format ---------- */

test("transcript contains agent names in correct order", async () => {
  const room = new MeetingRoom({ roomsDir: tempDir, provider: mockProvider });
  const agents = [makeAgent("alpha", "Alpha", tempDir), makeAgent("beta", "Beta", tempDir)];

  await room.runWithAgents(agents, "order-test", { turns: 1 });

  const today = new Date().toISOString().slice(0, 10);
  const transcriptPath = join(tempDir, "_meeting", "order-test", `${today}.md`);
  const content = readFileSync(transcriptPath, "utf-8");

  // alpha appears before beta in the first round
  const alphaIdx = content.indexOf("**alpha**");
  const betaIdx = content.indexOf("**beta**");
  expect(alphaIdx).toBeGreaterThan(0);
  expect(betaIdx).toBeGreaterThan(alphaIdx);
});

test("each turn has agent name and content in transcript", async () => {
  mockProvider = new MockProvider("special-content-xyz");
  const room = new MeetingRoom({ roomsDir: tempDir, provider: mockProvider });
  const agents = [makeAgent("bruno", "Bruno", tempDir)];

  await room.runWithAgents(agents, "content-test", { turns: 1 });

  const today = new Date().toISOString().slice(0, 10);
  const transcriptPath = join(tempDir, "_meeting", "content-test", `${today}.md`);
  const content = readFileSync(transcriptPath, "utf-8");

  expect(content).toContain("**bruno** —");
  expect(content).toContain("special-content-xyz");
  expect(content).toContain("---");
});

/* ---------- Transcript content passed to agents ---------- */

test("each agent receives previous turns in their prompt", async () => {
  const room = new MeetingRoom({ roomsDir: tempDir, provider: mockProvider });
  const agents = [makeAgent("first", "First", tempDir), makeAgent("second", "Second", tempDir)];

  await room.runWithAgents(agents, "context-test", { turns: 2 });

  // The second call's system prompt should contain the first agent's response
  const secondPrompt = mockProvider.capturedSystemPrompts[1];
  expect(secondPrompt).toContain("**first** —");
  expect(secondPrompt).toContain("mock response");
});

/* ---------- Path traversal protection (safeTopic) ---------- */

test("safeTopic slugifies path traversal attempts instead of traversing directories", async () => {
  const room = new MeetingRoom({ roomsDir: tempDir, provider: mockProvider });
  const agents = [makeAgent("bruno", "Bruno", tempDir)];

  // "../etc" should become "etc" after slugification — not traverse
  await room.runWithAgents(agents, "../etc", { turns: 1 });

  const today = new Date().toISOString().slice(0, 10);
  // The transcript should be under the slugified name, not the raw path
  const slugPath = join(tempDir, "_meeting", "etc", `${today}.md`);
  expect(existsSync(slugPath)).toBe(true);

  // The raw "../etc" should NOT have created a directory outside _meeting/
  const traversalPath = join(tempDir, "etc");
  expect(existsSync(traversalPath)).toBe(false);
});

test("safeTopic throws on topic that resolves to empty slug", async () => {
  const room = new MeetingRoom({ roomsDir: tempDir, provider: mockProvider });
  const agents = [makeAgent("bruno", "Bruno", tempDir)];

  // Pure punctuation resolves to empty slug → should throw
  await expect(room.runWithAgents(agents, "...", { turns: 1 })).rejects.toThrow("empty slug");
});

test("safeTopic preserves display topic in header while using slug for path", async () => {
  const room = new MeetingRoom({ roomsDir: tempDir, provider: mockProvider });
  const agents = [makeAgent("bruno", "Bruno", tempDir)];

  await room.runWithAgents(agents, "Hello World & More!", { turns: 1 });

  const today = new Date().toISOString().slice(0, 10);
  const slugPath = join(tempDir, "_meeting", "hello-world-more", `${today}.md`);
  expect(existsSync(slugPath)).toBe(true);

  const content = readFileSync(slugPath, "utf-8");
  // Header shows original topic, not slug
  expect(content).toContain("# Meeting: Hello World & More!");
});

/* ---------- Per-topic write lock serialization ---------- */

test("sequential runs on same topic accumulate turns via write lock chain", async () => {
  const room = new MeetingRoom({ roomsDir: tempDir, provider: mockProvider });
  const agents1 = [makeAgent("alpha", "Alpha", tempDir)];
  const agents2 = [makeAgent("beta", "Beta", tempDir)];

  // First run creates transcript
  await room.runWithAgents(agents1, "lock-test", { turns: 1 });

  // Second run resumes existing transcript
  await room.runWithAgents(agents2, "lock-test", { turns: 1, resume: true });

  const today = new Date().toISOString().slice(0, 10);
  const content = readFileSync(
    join(tempDir, "_meeting", "lock-test", `${today}.md`),
    "utf-8",
  );

  // Both agents appear
  expect(content).toContain("**alpha**");
  expect(content).toContain("**beta**");
  // Resume marker present
  expect(content).toContain("Resumed at");
  // Header intact
  expect(content).toContain("# Meeting: lock-test");
});

test("write lock prevents interleaving within single runWithAgents", async () => {
  // Simulate a slow provider to verify turns don't interleave
  const slowProvider = new MockProvider("slow response");
  const originalQuery = slowProvider.query.bind(slowProvider);
  slowProvider.query = async function (req: ProviderRequest) {
    await new Promise((r) => setTimeout(r, 5));
    return originalQuery(req);
  };

  const room = new MeetingRoom({ roomsDir: tempDir, provider: slowProvider });
  const agents = [makeAgent("bruno", "Bruno", tempDir), makeAgent("eli", "Eli", tempDir)];

  await room.runWithAgents(agents, "interleave-test", { turns: 2 });

  const today = new Date().toISOString().slice(0, 10);
  const content = readFileSync(
    join(tempDir, "_meeting", "interleave-test", `${today}.md`),
    "utf-8",
  );

  // Each turn block should be complete — bruno then eli in each round
  const lines = content.split("\n");
  const turnHeaders = lines.filter((l) => l.startsWith("**") && l.includes(" — "));
  expect(turnHeaders.length).toBe(4); // 2 agents x 2 rounds
  // Order: bruno, eli, bruno, eli (round-robin within rounds)
  expect(turnHeaders[0]).toContain("**bruno**");
  expect(turnHeaders[1]).toContain("**eli**");
  expect(turnHeaders[2]).toContain("**bruno**");
  expect(turnHeaders[3]).toContain("**eli**");
});
