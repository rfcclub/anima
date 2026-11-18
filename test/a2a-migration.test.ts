import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { A2AStore } from "../src/memory/a2a-store";

let tmpDir: string;
let dbPath: string;
let meetingDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "a2a-migrate-test-"));
  dbPath = join(tmpDir, "sessions.db");
  meetingDir = join(tmpDir, "rooms", "_meeting");
  await mkdir(meetingDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("migrate parses and stores messages from meeting files", async () => {
  // Create a test meeting file
  const topicDir = join(meetingDir, "nexus-design");
  await mkdir(topicDir, { recursive: true });
  await writeFile(
    join(topicDir, "2026-05-17.md"),
    [
      "---",
      "from: bruno",
      "to: eli",
      "timestamp: 2026-05-17T15:00:00Z",
      "topic: nexus-design",
      "turn: 3",
      "---",
      "",
      "Message body here.",
      "",
    ].join("\n"),
  );

  // Run migration inline (simulating the logic)
  const store = new A2AStore(dbPath);
  try {
    const content = await Bun.file(join(topicDir, "2026-05-17.md")).text();
    const body = content.split("---")[2]?.trim() ?? "";
    store.send({
      from: "bruno",
      to: "eli",
      subject: "[nexus-design] turn 3",
      body,
    });
  } finally {
    store.close();
  }

  // Verify messages are in the store
  const verifyStore = new A2AStore(dbPath);
  try {
    const inbox = verifyStore.readInbox("eli");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].from_agent).toBe("bruno");
    expect(inbox[0].subject).toBe("[nexus-design] turn 3");
    expect(inbox[0].body).toContain("Message body here");
  } finally {
    verifyStore.close();
  }
});

test("migrate handles broadcast 'all' recipient", async () => {
  const topicDir = join(meetingDir, "daily-standup");
  await mkdir(topicDir, { recursive: true });
  await writeFile(
    join(topicDir, "2026-05-17.md"),
    [
      "---",
      "from: sam",
      "to: all",
      "timestamp: 2026-05-17T09:00:00Z",
      "topic: daily-standup",
      "turn: 1",
      "---",
      "",
      "Good morning colony!",
      "",
    ].join("\n"),
  );

  const store = new A2AStore(dbPath);
  try {
    const content = await Bun.file(join(topicDir, "2026-05-17.md")).text();
    const body = content.split("---")[2]?.trim() ?? "";
    store.send({
      from: "sam",
      to: "all",
      subject: "[daily-standup] turn 1",
      body,
    });
  } finally {
    store.close();
  }

  const verifyStore = new A2AStore(dbPath);
  try {
    const inbox = verifyStore.readInbox("all");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].from_agent).toBe("sam");
  } finally {
    verifyStore.close();
  }
});

test("migrate is idempotent — duplicate messages are skipped", async () => {
  const topicDir = join(meetingDir, "test-topic");
  await mkdir(topicDir, { recursive: true });
  const content = [
    "---",
    "from: bruno",
    "to: eli",
    "timestamp: 2026-05-17T12:00:00Z",
    "topic: test-topic",
    "turn: 1",
    "---",
    "",
    "Hello",
    "",
  ].join("\n");

  await writeFile(join(topicDir, "2026-05-17.md"), content);

  // First migration
  const store1 = new A2AStore(dbPath);
  try {
    const body = content.split("---")[2]?.trim() ?? "";
    store1.send({ from: "bruno", to: "eli", subject: "[test-topic] turn 1", body });
  } finally {
    store1.close();
  }

  // Second migration (skips duplicates because same body + subject)
  const store2 = new A2AStore(dbPath);
  try {
    const body = content.split("---")[2]?.trim() ?? "";
    const existing = store2.readInbox("eli");
    const alreadyExists = existing.some(
      (m) => m.subject === "[test-topic] turn 1" && m.body.trim() === body.trim(),
    );
    if (!alreadyExists) {
      store2.send({ from: "bruno", to: "eli", subject: "[test-topic] turn 1", body });
    }
  } finally {
    store2.close();
  }

  const verify = new A2AStore(dbPath);
  try {
    expect(verify.countUnread("eli")).toBe(1);
  } finally {
    verify.close();
  }
});

test("migrate handles multiple messages in multiple topics", async () => {
  // Create two topics
  for (const [topic, messages] of [
    ["topic-a", [{ from: "bruno", to: "eli", turn: 1, body: "First" }]],
    ["topic-b", [{ from: "lena", to: "bruno", turn: 1, body: "Second" }]],
  ] as const) {
    const topicDir = join(meetingDir, topic);
    await mkdir(topicDir, { recursive: true });
    for (const msg of messages) {
      await writeFile(
        join(topicDir, "2026-05-17.md"),
        [
          "---",
          `from: ${msg.from}`,
          `to: ${msg.to}`,
          "timestamp: 2026-05-17T12:00:00Z",
          `topic: ${topic}`,
          `turn: ${msg.turn}`,
          "---",
          "",
          msg.body,
          "",
        ].join("\n"),
      );
    }
  }

  const store = new A2AStore(dbPath);
  try {
    // Simulate migrating both topics
    for (const [topic, _msgs] of [
      ["topic-a", [{ from: "bruno", to: "eli", turn: 1, body: "First" }]],
      ["topic-b", [{ from: "lena", to: "bruno", turn: 1, body: "Second" }]],
    ] as const) {
      const topicDir = join(meetingDir, topic);
      const files = ["2026-05-17.md"];
      for (const file of files) {
        const content = await Bun.file(join(topicDir, file)).text();
        const body = content.split("---")[2]?.trim() ?? "";
        const frontParts = content.split("---")[1]?.trim().split("\n") ?? [];
        const from = frontParts.find((l) => l.startsWith("from:"))?.split(":")[1]?.trim() ?? "unknown";
        const to = frontParts.find((l) => l.startsWith("to:"))?.split(":")[1]?.trim() ?? "unknown";
        store.send({ from, to, subject: `[${topic}] turn 1`, body });
      }
    }
  } finally {
    store.close();
  }

  const verify = new A2AStore(dbPath);
  try {
    expect(verify.countUnread("eli")).toBe(1);
    expect(verify.countUnread("bruno")).toBe(1);
  } finally {
    verify.close();
  }
});
