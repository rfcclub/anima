import { test, expect } from "bun:test";
import {
  applyStreamEvent,
  contextualStatus,
  LOADING_WORDS,
  type ChatMessage,
} from "../../src/ui/features/town/lib/streamReducer";

function placeholder(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { role: "assistant", content: "", agent: "bruno", streaming: true, loadingWord: "thinking…", ...overrides };
}

// SC-001: single tool call during a turn
test("tool_use then text then done leaves exactly one message", () => {
  let messages: ChatMessage[] = [placeholder()];
  messages = applyStreamEvent(messages, { kind: "tool_use", name: "bash", summary: "bash(ls)" });
  expect(messages.length).toBe(1);
  messages = applyStreamEvent(messages, { kind: "text", text: "done!" });
  expect(messages.length).toBe(1);
  messages = applyStreamEvent(messages, { kind: "done" });
  expect(messages.length).toBe(1);
  expect(messages[0].content).toBe("done!");
  expect(messages[0].streaming).toBe(false);
});

// SC-002: multiple sequential tool calls during one turn
test("three sequential tool_use events never grow the message list", () => {
  let messages: ChatMessage[] = [placeholder()];
  messages = applyStreamEvent(messages, { kind: "tool_use", name: "grep", summary: "grep(TODO)" });
  expect(messages.length).toBe(1);
  messages = applyStreamEvent(messages, { kind: "tool_use", name: "read", summary: "read(a.ts)" });
  expect(messages.length).toBe(1);
  messages = applyStreamEvent(messages, { kind: "tool_use", name: "write", summary: "write(b.ts)" });
  expect(messages.length).toBe(1);
  messages = applyStreamEvent(messages, { kind: "text", text: "all set" });
  messages = applyStreamEvent(messages, { kind: "done" });
  expect(messages.length).toBe(1);
  expect(messages[0].content).toBe("all set");
});

// SC-003: second tool_use event replaces the first indicator's text
test("second tool_use overwrites toolStatus without adding an entry", () => {
  let messages: ChatMessage[] = [placeholder()];
  messages = applyStreamEvent(messages, { kind: "tool_use", name: "bash", summary: "bash(npm test)" });
  const afterFirst = messages[0].toolStatus;
  messages = applyStreamEvent(messages, { kind: "tool_use", name: "grep", summary: "grep(FIXME)" });
  expect(messages.length).toBe(1);
  expect(messages[0].toolStatus).not.toBe(afterFirst);
  expect(messages[0].toolStatus).toContain("searching");
});

// SC-004: real text clears toolStatus without altering content derivation
test("text event clears toolStatus once real content starts arriving", () => {
  let messages: ChatMessage[] = [placeholder()];
  messages = applyStreamEvent(messages, { kind: "tool_use", name: "bash", summary: "bash(ls)" });
  expect(messages[0].toolStatus).toBeDefined();
  messages = applyStreamEvent(messages, { kind: "text", text: "here you go" });
  expect(messages[0].content).toBe("here you go");
  expect(messages[0].toolStatus).toBeUndefined();
});

// SC-013: loadingWord and content are never touched by tool_use events
test("loadingWord and content survive tool_use events unchanged", () => {
  let messages: ChatMessage[] = [placeholder({ loadingWord: "brewing…" })];
  messages = applyStreamEvent(messages, { kind: "tool_use", name: "bash", summary: "bash(ls)" });
  messages = applyStreamEvent(messages, { kind: "tool_use", name: "grep", summary: "grep(TODO)" });
  expect(messages[0].loadingWord).toBe("brewing…");
  expect(messages[0].content).toBe("");
  expect(messages[0].toolStatus).toContain("searching");
});

// SC-005: stream ends with no trailing text after the last tool call
test("done with empty content removes the placeholder entirely", () => {
  let messages: ChatMessage[] = [placeholder()];
  messages = applyStreamEvent(messages, { kind: "tool_use", name: "bash", summary: "bash(ls)" });
  messages = applyStreamEvent(messages, { kind: "done" });
  expect(messages.length).toBe(0);
});

// SC-006: error terminates a turn with an active indicator
test("error event replaces content, clears toolStatus, and stops streaming", () => {
  let messages: ChatMessage[] = [placeholder()];
  messages = applyStreamEvent(messages, { kind: "tool_use", name: "bash", summary: "bash(ls)" });
  messages = applyStreamEvent(messages, { kind: "error", message: "Error: boom" });
  expect(messages.length).toBe(1);
  expect(messages[0].content).toBe("Error: boom");
  expect(messages[0].toolStatus).toBeUndefined();
  expect(messages[0].streaming).toBe(false);
});

// applyStreamEvent is a no-op when there is no active streaming placeholder
test("event with no active placeholder is a no-op", () => {
  const messages: ChatMessage[] = [{ role: "assistant", content: "final", agent: "bruno", streaming: false }];
  const result = applyStreamEvent(messages, { kind: "text", text: "late" });
  expect(result).toEqual(messages);
});

// SC-007: known tool name yields contextual phrasing
test("contextualStatus('bash', ...) mentions running and the summary", () => {
  const status = contextualStatus("bash", "bash(npm audit fix)");
  expect(status).toContain("running");
  expect(status).toContain("npm audit fix");
});

// SC-008: another known tool name yields distinct phrasing
test("contextualStatus('grep', ...) mentions searching, distinct from bash", () => {
  const bashStatus = contextualStatus("bash", "bash(ls)");
  const grepStatus = contextualStatus("grep", "grep(TODO)");
  expect(grepStatus).toContain("searching");
  expect(grepStatus).not.toBe(bashStatus);
});

// SC-009: unknown tool name falls back gracefully
test("contextualStatus falls back to a LOADING_WORDS entry for unknown tools", () => {
  const status = contextualStatus("some_future_tool", "some_future_tool(x)");
  const bareWords = LOADING_WORDS.map(w => w + "…");
  expect(bareWords).toContain(status);
});
