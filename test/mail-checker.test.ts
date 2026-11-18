import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MailChecker } from "../src/meeting/daemon";

let tempDir: string;
let roomsDir: string;

beforeEach(async () => {
  tempDir = await Bun.write(Bun.file("/dev/null"), "").then(async () => {
    const path = join(tmpdir(), `anima-mail-${crypto.randomUUID()}`);
    await mkdir(path, { recursive: true });
    return path;
  });
  roomsDir = join(tempDir, "rooms");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("check returns unread messages for agent-specific to: field", async () => {
  await writeMessage("nexus-design", "2026-05-17", {
    from: "bruno",
    to: "eli",
    timestamp: "2026-05-17T15:00:00Z",
    topic: "nexus-design",
    turn: 1,
    body: "Eli, please review the daemon plan.",
  });
  await writeMessage("nexus-design", "2026-05-18", {
    from: "milo",
    to: "sam",
    timestamp: "2026-05-17T15:05:00Z",
    topic: "nexus-design",
    turn: 2,
    body: "Sam-only note.",
  });

  const checker = new MailChecker({ roomsDir });
  const messages = await checker.check("eli", "2026-05-17T14:00:00Z");

  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    from: "bruno",
    to: "eli",
    topic: "nexus-design",
    timestamp: "2026-05-17T15:00:00Z",
    body: "Eli, please review the daemon plan.",
  });
});

test("check returns unread messages for to: all", async () => {
  await writeMessage("agent-home", "2026-05-17", {
    from: "sam",
    to: "all",
    timestamp: "2026-05-17T16:00:00Z",
    topic: "agent-home",
    turn: 1,
    body: "Broadcast status update.",
  });

  const checker = new MailChecker({ roomsDir });
  const messages = await checker.check("eli", "2026-05-17T15:00:00Z");

  expect(messages).toHaveLength(1);
  expect(messages[0]?.to).toBe("all");
  expect(messages[0]?.body).toBe("Broadcast status update.");
});

test("check filters by lastActivity timestamp correctly", async () => {
  await writeMessage("time-filter-old", "2026-05-17", {
    from: "bruno",
    to: "eli",
    timestamp: "2026-05-17T14:59:59Z",
    topic: "time-filter-old",
    turn: 1,
    body: "Old note.",
  });
  await writeMessage("time-filter-equal", "2026-05-17", {
    from: "bruno",
    to: "eli",
    timestamp: "2026-05-17T15:00:00Z",
    topic: "time-filter-equal",
    turn: 1,
    body: "Equal timestamp note.",
  });
  await writeMessage("time-filter-new", "2026-05-17", {
    from: "bruno",
    to: "eli",
    timestamp: "2026-05-17T15:00:01Z",
    topic: "time-filter-new",
    turn: 1,
    body: "New note.",
  });

  const checker = new MailChecker({ roomsDir });
  const messages = await checker.check("eli", "2026-05-17T15:00:00Z");

  expect(messages.map((message) => message.topic)).toEqual(["time-filter-new"]);
});

test("check returns empty array when no matching messages", async () => {
  await writeMessage("quiet-room", "2026-05-17", {
    from: "bruno",
    to: "milo",
    timestamp: "2026-05-17T16:00:00Z",
    topic: "quiet-room",
    turn: 1,
    body: "Not for Eli.",
  });

  const checker = new MailChecker({ roomsDir });
  const messages = await checker.check("eli", "2026-05-17T15:00:00Z");

  expect(messages).toEqual([]);
});

test("markRead writes correct checkpoint JSON", async () => {
  const checker = new MailChecker({ roomsDir });

  await checker.markRead("eli", "nexus-design", "2026-05-17T15:00:00Z");

  const checkpointPath = join(roomsDir, "eli", "mail-checkpoint.json");
  const checkpoint = await Bun.file(checkpointPath).json();
  expect(checkpoint).toEqual({
    "nexus-design": "2026-05-17T15:00:00Z",
  });
});

test("formatMailContext formats messages correctly", () => {
  const checker = new MailChecker({ roomsDir });
  const formatted = checker.formatMailContext([
    {
      from: "bruno",
      to: "eli",
      timestamp: "2026-05-17T15:00:00Z",
      topic: "nexus-design",
      turn: 1,
      body: "Please check the room daemon.",
    },
    {
      from: "sam",
      to: "all",
      timestamp: "2026-05-17T16:00:00Z",
      topic: "agent-home",
      turn: 2,
      body: "Shared update.",
    },
  ]);

  expect(formatted).toBe([
    "[Unread A2A — from bruno in topic nexus-design at 2026-05-17T15:00:00Z]",
    "bruno: Please check the room daemon.",
    "",
    "[Unread A2A — from sam in topic agent-home at 2026-05-17T16:00:00Z]",
    "sam: Shared update.",
  ].join("\n"));
});

test("circuit breaker: >50 unread returns empty and logs warning", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    for (let i = 0; i < 51; i++) {
      await writeMessage(`overflow-${String(i).padStart(2, "0")}`, "2026-05-17", {
        from: "bruno",
        to: "eli",
        timestamp: `2026-05-17T15:${String(i).padStart(2, "0")}:00Z`,
        topic: `overflow-${String(i).padStart(2, "0")}`,
        turn: 1,
        body: `Overflow ${i}`,
      });
    }

    const checker = new MailChecker({ roomsDir });
    const messages = await checker.check("eli", "2026-05-17T14:00:00Z");

    expect(messages).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(String(warnings[0]?.[0])).toContain("mail circuit breaker");
    expect(String(warnings[0]?.[0])).toContain("eli");
    expect(String(warnings[0]?.[0])).toContain("51");
  } finally {
    console.warn = originalWarn;
  }
});

async function writeMessage(
  topic: string,
  date: string,
  message: {
    from: string;
    to: string;
    timestamp: string;
    topic: string;
    turn: number;
    body: string;
  },
): Promise<void> {
  const dir = join(roomsDir, "_meeting", topic);
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, `${date}.md`),
    [
      "---",
      `from: ${message.from}`,
      `to: ${message.to}`,
      `timestamp: ${message.timestamp}`,
      `topic: ${message.topic}`,
      `turn: ${message.turn}`,
      "---",
      "",
      message.body,
      "",
    ].join("\n"),
  );
}
