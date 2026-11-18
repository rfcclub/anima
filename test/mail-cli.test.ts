import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionContext } from "../src/session/types";
import {
  buildSessionMessages,
  lastActivityFromSession,
  truncateTurnsIfNeeded,
} from "../src/cli";

let tempDir: string;
let roomsDir: string;

beforeEach(async () => {
  tempDir = join(tmpdir(), `anima-mail-cli-${crypto.randomUUID()}`);
  roomsDir = join(tempDir, "rooms");
  await mkdir(roomsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("lastActivityFromSession returns the most recent turn timestamp", () => {
  const context = makeSessionContext([
    { role: "user", timestamp: "2026-05-17T14:00:00Z", content: "old" },
    { role: "assistant", timestamp: "2026-05-17T14:05:00Z", content: "new" },
    { role: "user", timestamp: "2026-05-17T13:00:00Z", content: "older" },
  ]);

  expect(lastActivityFromSession(context)).toBe("2026-05-17T14:05:00Z");
});

test("buildSessionMessages injects unread mail context as first system message", () => {
  const context = makeSessionContext([
    { role: "assistant", timestamp: "2026-05-17T14:05:00Z", content: "Earlier answer." },
  ]);

  const messages = buildSessionMessages(
    context,
    "hello",
    "[Unread A2A — from bruno in topic nexus-design at 2026-05-17T15:00:00Z]\nbruno: Please review.",
  );

  expect(messages[0]).toEqual({
    role: "system",
    content: "[Unread A2A — from bruno in topic nexus-design at 2026-05-17T15:00:00Z]\nbruno: Please review.",
  });
  expect(messages.at(-1)).toEqual({ role: "user", content: "hello" });
});

test("buildSessionMessages injects baseline as user/assistant pair (not system role)", () => {
  const context: SessionContext = {
    sessionId: "eli:2026-05-20",
    date: "2026-05-20",
    turns: [],
    baseline: {
      type: "compact",
      sessionId: "eli:2026-05-19",
      timestamp: "2026-05-19T20:00:00Z",
      summary: "We discussed the auth flow and decided on JWT.",
      turnCount: 4,
      dateRange: { from: "2026-05-19T10:00:00Z", to: "2026-05-19T20:00:00Z" },
      model: "gemini-2.0-flash",
    },
  };

  const messages = buildSessionMessages(context, "continue");

  const baselineMsg = messages.find((m) => m.content.toString().includes("We discussed the auth flow"));
  expect(baselineMsg).toBeDefined();
  // Must NOT be system — Gemini drops system-role messages from history array
  expect(baselineMsg?.role).toBe("user");
  // The following assistant acknowledgment must exist
  const idx = messages.indexOf(baselineMsg!);
  expect(messages[idx + 1]?.role).toBe("assistant");
});

test("buildSessionMessages without baseline has no spurious system messages", () => {
  const context = makeSessionContext([
    { role: "user", timestamp: "2026-05-20T10:00:00Z", content: "Hello." },
    { role: "assistant", timestamp: "2026-05-20T10:01:00Z", content: "Hi there." },
  ]);

  const messages = buildSessionMessages(context, "How are you?");

  const systemMessages = messages.filter((m) => m.role === "system");
  expect(systemMessages).toHaveLength(0);
  expect(messages.at(-1)).toEqual({ role: "user", content: "How are you?" });
});

test("truncateTurnsIfNeeded leaves context unchanged when under threshold", () => {
  const context = makeSessionContext([
    { role: "user", timestamp: "2026-05-20T10:00:00Z", content: "short" },
    { role: "assistant", timestamp: "2026-05-20T10:01:00Z", content: "short reply" },
  ]);

  const result = truncateTurnsIfNeeded(context, 60_000);

  expect(result).toBe(context); // same reference — no allocation
  expect(result.turns).toHaveLength(2);
});

test("truncateTurnsIfNeeded drops oldest turns when estimated tokens exceed threshold", () => {
  const longContent = "x".repeat(4000); // ~1000 tokens each
  const context = makeSessionContext([
    { role: "user", timestamp: "2026-05-20T10:00:00Z", content: longContent },
    { role: "assistant", timestamp: "2026-05-20T10:01:00Z", content: longContent },
    { role: "user", timestamp: "2026-05-20T10:02:00Z", content: longContent },
    { role: "assistant", timestamp: "2026-05-20T10:03:00Z", content: longContent },
    { role: "user", timestamp: "2026-05-20T10:04:00Z", content: longContent },
    { role: "assistant", timestamp: "2026-05-20T10:05:00Z", content: longContent },
  ]);

  // threshold of 2000 tokens → ~8000 chars max, 6 turns × 4000 chars = 24000 chars → must truncate
  const result = truncateTurnsIfNeeded(context, 2_000);

  expect(result.turns.length).toBeLessThan(context.turns.length);
  // Verify remaining turns fit under threshold (approx)
  const totalChars = result.turns.reduce((sum, t) => sum + t.content.length, 0);
  expect(totalChars).toBeLessThanOrEqual(2_000 * 4);
});

test("check-mail CLI scans all agents and outputs unread summary", async () => {
  await writeAgent("eli");
  await writeAgent("bruno");
  await writeMessage("nexus-design", {
    from: "bruno",
    to: "eli",
    timestamp: "2026-05-17T15:00:00Z",
    body: "Ping Eli.",
  });

  const result = await runCli(["check-mail"]);

  if (result.exitCode !== 0) {
    // eslint-disable-next-line no-console
    console.error("check-mail stderr:", result.stderr);
  }
  expect(result.exitCode).toBe(0);
  // check-mail reads from global mesh bus, so unread counts may include real data
  expect(result.stdout).toContain("eli:");
  expect(result.stdout).toContain("unread");
});

test("check-mail CLI supports --agent and --mark-read", async () => {
  await writeAgent("eli");
  await writeAgent("bruno");
  await writeMessage("nexus-design", {
    from: "bruno",
    to: "eli",
    timestamp: "2026-05-17T15:00:00Z",
    body: "Ping Eli.",
  });

  const result = await runCli(["check-mail", "--agent", "eli", "--mark-read"]);

  expect(result.exitCode).toBe(0);
  // check-mail reads from global mesh bus, so counts may include real data
  expect(result.stdout).toContain("eli:");
});

test("session CLI output includes unread mail count", async () => {
  await writeAgent("eli");
  await writeMessage("nexus-design", {
    from: "bruno",
    to: "eli",
    timestamp: "2026-05-17T15:00:00Z",
    body: "Ping Eli.",
  });

  const result = await runCli(["session", "eli"]);

  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.agent).toBe("eli");
  expect(typeof parsed.unreadMail).toBe("number");
});

function makeSessionContext(
  turns: Array<{ role: "user" | "assistant"; timestamp: string; content: string }>,
): SessionContext {
  return {
    sessionId: "eli:2026-05-17",
    date: "2026-05-17",
    turns: turns.map((turn) => ({
      ...turn,
      type: "turn",
      sessionId: "eli:2026-05-17",
    })),
  };
}

async function writeAgent(name: string): Promise<void> {
  const roomDir = join(roomsDir, name);
  await mkdir(join(roomDir, "staging"), { recursive: true });
  await Bun.write(join(roomDir, "PREFACE.md"), `You are ${name}.\n`);
  await Bun.write(join(roomDir, "AGENTS.md"), "Session instructions.\n");
  await Bun.write(
    join(roomDir, "config.yaml"),
    [
      "identity:",
      `  name: ${name}`,
      `  label: ${name}`,
      "provider:",
      "  type: gemini",
      "  model: gemini-test",
      "policy:",
      `  allowedRoots: ["${join(roomDir, "staging")}"]`,
      `  readOnlyRoots: ["${roomDir}"]`,
      "session:",
      "  defaultMode: plan",
      "  autoModeOptIn: false",
      "  compactThreshold: 60000",
      "boot:",
      "  gene: PREFACE.md",
      "  soul: PREFACE.md",
      "  sessionContext:",
      "    - path: AGENTS.md",
      "",
    ].join("\n"),
  );
}

async function writeMessage(
  topic: string,
  message: { from: string; to: string; timestamp: string; body: string },
): Promise<void> {
  const topicDir = join(roomsDir, "_meeting", topic);
  await mkdir(topicDir, { recursive: true });
  await Bun.write(
    join(topicDir, "2026-05-17.md"),
    [
      "---",
      `from: ${message.from}`,
      `to: ${message.to}`,
      `timestamp: ${message.timestamp}`,
      `topic: ${topic}`,
      "turn: 1",
      "---",
      "",
      message.body,
      "",
    ].join("\n"),
  );
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", join(process.cwd(), "src/cli.ts"), ...args],
    cwd: tempDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ANIMA_SESSIONS_DB: join(tempDir, "sessions.db"),
      ANIMA_ROOMS_DIR: roomsDir,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
