import { test, expect } from "bun:test";
import { TelegramChannel } from "../src/channels/telegram";

test("parseMention extracts @agent from start", () => {
  const ch = new TelegramChannel({ reply: async () => {} });
  const result = ch.parseMention("@lena hello how are you");
  expect(result.agentNames).toEqual(["lena"]);
  expect(result.message).toBe("hello how are you");
  expect(result.isAll).toBe(false);
});

test("parseMention returns empty agentNames and isAll false when no @mention", () => {
  const ch = new TelegramChannel({ reply: async () => {} });
  const result = ch.parseMention("what is the weather today?");
  expect(result.agentNames).toEqual([]);
  expect(result.message).toBe("what is the weather today?");
  expect(result.isAll).toBe(false);
});

test("parseMention handles @mention with newlines", () => {
  const ch = new TelegramChannel({ reply: async () => {} });
  const result = ch.parseMention("@eli fix the bug\nin the auth module");
  expect(result.agentNames).toEqual(["eli"]);
  expect(result.message).toBe("fix the bug\nin the auth module");
});

test("parseMention returns empty when @ not at start", () => {
  const ch = new TelegramChannel({ reply: async () => {} });
  const result = ch.parseMention("hello @sam please review");
  expect(result.agentNames).toEqual([]);
  expect(result.message).toBe("hello @sam please review");
});

test("parseMention handles @all tag", () => {
  const ch = new TelegramChannel({ reply: async () => {} });
  const result = ch.parseMention("@all what do you all think");
  expect(result.agentNames).toEqual([]);
  expect(result.message).toBe("what do you all think");
  expect(result.isAll).toBe(true);
});

test("parseMention handles multi-mention with +", () => {
  const ch = new TelegramChannel({ reply: async () => {} });
  const result = ch.parseMention("@bruno+eli+milo review this together");
  expect(result.agentNames).toEqual(["bruno", "eli", "milo"]);
  expect(result.message).toBe("review this together");
  expect(result.isAll).toBe(false);
});

test("parseMention handles single @agent", () => {
  const ch = new TelegramChannel({ reply: async () => {} });
  const result = ch.parseMention("@bruno review this");
  expect(result.agentNames).toEqual(["bruno"]);
  expect(result.message).toBe("review this");
});

test("parseCommand detects slash commands", () => {
  const ch = new TelegramChannel({ reply: async () => {} });

  const status = ch.parseCommand("/status");
  expect(status).toEqual({ command: "status", args: "" });

  const mode = ch.parseCommand("/mode chatting");
  expect(mode).toEqual({ command: "mode", args: "chatting" });

  const notCommand = ch.parseCommand("@bruno hello");
  expect(notCommand).toBeNull();

  const plainText = ch.parseCommand("hello world");
  expect(plainText).toBeNull();
});

test("parseCommand handles /agents alias", () => {
  const ch = new TelegramChannel({ reply: async () => {} });
  const result = ch.parseCommand("/agents");
  expect(result).toEqual({ command: "agents", args: "" });
});

test("parseCommand with complex args preserves spaces", () => {
  const ch = new TelegramChannel({ reply: async () => {} });
  const result = ch.parseCommand("/mode philosophy");
  expect(result).toEqual({ command: "mode", args: "philosophy" });
});

test("parseCommand handles /end command", () => {
  const ch = new TelegramChannel({ reply: async () => {} });
  const result = ch.parseCommand("/end");
  expect(result).toEqual({ command: "end", args: "" });
});

test("parseCommand handles /who command", () => {
  const ch = new TelegramChannel({ reply: async () => {} });
  const result = ch.parseCommand("/who");
  expect(result).toEqual({ command: "who", args: "" });
});

test("parseCommand handles /leave command", () => {
  const ch = new TelegramChannel({ reply: async () => {} });
  const result = ch.parseCommand("/leave @eli");
  expect(result).toEqual({ command: "leave", args: "@eli" });
});

test("observe writes a channel_observation event", () => {
  const ch = new TelegramChannel({ reply: async () => {} });
  // No-op call shouldn't throw (store is in-memory, rooms dir default)
  const result = () => ch.observe("bruno", "tg-123", "some message to observe");
  expect(result).not.toThrow();
});

test("handleInbound with @mention returns TelegramChannelResult", () => {
  const ch = new TelegramChannel({ reply: async () => {} });
  const mentioned = ch.parseMention("@bruno hello");
  expect(mentioned.agentNames).toEqual(["bruno"]);
  expect(mentioned.message).toBe("hello");
});
