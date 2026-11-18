import { test, expect, describe } from "bun:test";
import { buildSystemPrompt, addInboxSummary } from "../src/agents/prompter";
import type { LoadedAgent } from "../src/agents/loader";

function makeMinimalAgent(overrides?: Partial<LoadedAgent>): LoadedAgent {
  return {
    name: "test-agent",
    label: "Test Agent",
    labelOverride: undefined,
    roomDir: "/tmp/rooms/test-agent",
    config: {
      identity: { name: "test-agent", label: "Test Agent" },
      provider: { type: "gemini" as any, model: "test-model" },
      policy: { allowedRoots: ["/tmp"], allowedTools: [] },
      session: { defaultMode: "plan" as any, autoModeOptIn: false, compactThreshold: 100 },
      boot: { gene: "", soul: "" },
    },
    soulContent: "",
    geneContent: "Test instructions.",
    sessionContextFiles: [],
    additionalSessionContext: [],
    additionalContent: [],
    extraActionResults: [],
  };
}

test("buildSystemPrompt without inbox summary does not include Inbox section", () => {
  const agent = makeMinimalAgent();
  const prompt = buildSystemPrompt(agent).full;
  expect(prompt).not.toContain("Inbox");
  expect(prompt).not.toContain("unread");
});

test("addInboxSummary injects inbox section when unread > 0", () => {
  const agent = makeMinimalAgent();
  const prompt = buildSystemPrompt(agent).full;

  const inboxMessages = [
    { from_agent: "ivan", subject: "Weekly metrics report", ts: "2026-05-21T10:00:00Z" },
    { from_agent: "lena", subject: "Question about cartridge config", ts: "2026-05-21T11:00:00Z" },
  ];

  const result = addInboxSummary(prompt, inboxMessages);

  expect(result).toContain("## Inbox");
  expect(result).toContain("2 unread");
  expect(result).toContain("ivan");
  expect(result).toContain("Weekly metrics report");
  expect(result).toContain("lena");
  expect(result).toContain("Question about cartridge config");
});

test("addInboxSummary with single unread message", () => {
  const agent = makeMinimalAgent();
  const prompt = buildSystemPrompt(agent).full;

  const inboxMessages = [
    { from_agent: "eli", subject: "Review request", ts: "2026-05-21T12:00:00Z" },
  ];

  const result = addInboxSummary(prompt, inboxMessages);
  expect(result).toContain("## Inbox");
  expect(result).toContain("1 unread");
  expect(result).toContain("eli");
  expect(result).toContain("Review request");
});

test("addInboxSummary with empty list does not modify prompt", () => {
  const agent = makeMinimalAgent();
  const prompt = buildSystemPrompt(agent).full;
  const result = addInboxSummary(prompt, []);
  expect(result).toBe(prompt);
});

test("inbox summary appears before ## Runtime section", () => {
  const agent = makeMinimalAgent();
  const prompt = buildSystemPrompt(agent).full;

  const inboxMessages = [
    { from_agent: "ivan", subject: "Test", ts: "2026-05-21T10:00:00Z" },
  ];

  const result = addInboxSummary(prompt, inboxMessages);
  const inboxIdx = result.indexOf("## Inbox");
  const runtimeIdx = result.indexOf("## Runtime");
  expect(inboxIdx).toBeGreaterThan(0);
  expect(runtimeIdx).toBeGreaterThan(inboxIdx);
});
