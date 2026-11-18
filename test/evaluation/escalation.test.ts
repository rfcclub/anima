import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EscalationSystem } from "../../src/evaluation/escalation";
import { TRUST_DOMAINS, TrustSystem } from "../../src/evaluation/trust-system";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let roomsDir: string;
let frozenNow: Date;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `anima-escalation-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  roomsDir = join(tempDir, "rooms");
  mkdirSync(roomsDir, { recursive: true });
  frozenNow = new Date("2026-05-19T12:00:00.000Z");
});

function system(): EscalationSystem {
  return new EscalationSystem({ roomsDir, now: () => frozenNow });
}

function trustSystem(): TrustSystem {
  return new TrustSystem({ roomsDir, now: () => frozenNow });
}

/** Write a review queue entry for testing. */
function writeReviewEntry(
  agentId: string,
  timestamp: string,
  overrides: Record<string, unknown> = {},
): string {
  const queueDir = join(roomsDir, agentId, "review_queue");
  mkdirSync(queueDir, { recursive: true });

  const filename = timestamp.replace(/[:.]/g, "-") + ".json";
  const entry = {
    timestamp,
    domain: "code",
    output: "some output that was held for review",
    report: {
      confidence: 0.5,
      flags: ["Suspicious pattern detected"],
      rationale: "Confidence below threshold, holding for review",
      testsRun: ["No debug logs", "YAGNI check"],
    },
    ...overrides,
  };

  writeFileSync(join(queueDir, filename), JSON.stringify(entry, null, 2), "utf-8");
  return `${agentId}/${filename.replace(".json", "")}`;
}

/** Read a trust file for an agent. */
function readTrust(agentId: string): Record<string, unknown> {
  const trustPath = join(roomsDir, agentId, "trust.json");
  return JSON.parse(readFileSync(trustPath, "utf-8"));
}

// ---------------------------------------------------------------------------
// Task 9.1: /review lists pending items
// ---------------------------------------------------------------------------

test("9.1a list returns items from all agents sorted by timestamp", async () => {
  writeReviewEntry("bruno", "2026-05-19T10:00:00.000Z");
  writeReviewEntry("eli", "2026-05-19T11:00:00.000Z");

  const items = await system().list();
  expect(items.length).toBe(2);
  expect(items[0].agentId).toBe("bruno");
  expect(items[1].agentId).toBe("eli");
});

test("9.1b list returns empty array when no review queue exists", async () => {
  const items = await system().list();
  expect(items).toEqual([]);
});

test("9.1c item has expected fields", async () => {
  const id = writeReviewEntry("bruno", "2026-05-19T10:00:00.000Z");
  const items = await system().list();
  expect(items.length).toBe(1);

  const item = items[0];
  expect(item.id).toBe(id);
  expect(item.agentId).toBe("bruno");
  expect(item.domain).toBe("code");
  expect(item.summary).toBeString();
  expect(item.report.confidence).toBe(0.5);
});

test("9.1d item summary is first 120 chars without newlines", async () => {
  writeReviewEntry("bruno", "2026-05-19T10:00:00.000Z", {
    output: "line1\nline2\nline3 with more text that should appear in the summary",
  });
  const items = await system().list();
  expect(items[0].summary).not.toContain("\n");
  expect(items[0].summary.length).toBeLessThanOrEqual(120);
});

// ---------------------------------------------------------------------------
// Task 9.2: Approve triggers trust confirm
// ---------------------------------------------------------------------------

test("9.2a approve confirms trust for agent+domain", async () => {
  const id = writeReviewEntry("bruno", "2026-05-19T10:00:00.000Z");

  // Get trust score before approve
  const ts = trustSystem();
  const before = await ts.get("bruno", "code_review");
  expect(before.score).toBe(0.5);

  // Approve
  const result = await system().approve(id);
  expect(result).not.toBeNull();
  expect(result!.agentId).toBe("bruno");
  expect(result!.domain).toBe("code_review");

  // Trust should have increased
  const after = await ts.get("bruno", "code_review");
  expect(after.score).toBeGreaterThan(0.5);
  expect(after.samples).toBe(1);
});

test("9.abel approve removes entry from queue", async () => {
  const id = writeReviewEntry("bruno", "2026-05-19T10:00:00.000Z");
  await system().approve(id);

  const items = await system().list();
  expect(items.length).toBe(0);
});

test("9.2c approve returns null for non-existent entry", async () => {
  const result = await system().approve("bruno/nonexistent");
  expect(result).toBeNull();
});

// ---------------------------------------------------------------------------
// Task 9.3: Reject triggers penalty
// ---------------------------------------------------------------------------

test("9.3a reject penalizes trust for agent+domain", async () => {
  // First confirm a few times to have non-trivial score
  const ts = trustSystem();
  await ts.confirm("bruno", "code_review");
  await ts.confirm("bruno", "code_review");

  const before = await ts.get("bruno", "code_review");
  expect(before.score).toBeGreaterThan(0.5);

  const id = writeReviewEntry("bruno", "2026-05-19T10:00:00.000Z");
  const result = await system().reject(id, "This output was incorrect");

  expect(result).not.toBeNull();
  expect(result!.agentId).toBe("bruno");

  const after = await ts.get("bruno", "code_review");
  expect(after.score).toBeLessThan(before.score);
});

test("9.3b reject logs feedback to learning store", async () => {
  const id = writeReviewEntry("bruno", "2026-05-19T10:00:00.000Z");
  await system().reject(id, "Incorrect reasoning in output");

  const rejectedDir = join(roomsDir, "bruno", "rejected");
  expect(existsSync(rejectedDir)).toBe(true);

  const files = readdirSync(rejectedDir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBeGreaterThanOrEqual(1);

  const log = JSON.parse(readFileSync(join(rejectedDir, files[0]), "utf-8"));
  expect(log.feedback).toBe("Incorrect reasoning in output");
  expect(log.domain).toBe("code");
});

test("9.3c reject removes entry from queue", async () => {
  const id = writeReviewEntry("bruno", "2026-05-19T10:00:00.000Z");
  await system().reject(id, "bad output");

  const items = await system().list();
  expect(items.length).toBe(0);
});

test("9.3d reject returns null for non-existent entry", async () => {
  const result = await system().reject("bruno/nonexistent", "feedback");
  expect(result).toBeNull();
});

// ---------------------------------------------------------------------------
// Task 9.4: Escalation notification
// ---------------------------------------------------------------------------

test("9.4 buildNotification returns formatted message", () => {
  const msg = system().buildNotification("bruno", "code", "bruno/2026-05-19T10-00-00-000Z");
  expect(msg).toInclude("bruno");
  expect(msg).toInclude("code");
  expect(msg).toInclude("/approve bruno/2026-05-19T10-00-00-000Z");
  expect(msg).toInclude("/reject bruno/2026-05-19T10-00-00-000Z");
});

// ---------------------------------------------------------------------------
// Task 9.5: Expired entries cleaned up
// ---------------------------------------------------------------------------

test("9.5a entries older than 48h are cleaned up on list", async () => {
  // Entry from 50 hours ago
  writeReviewEntry("bruno", "2026-05-17T10:00:00.000Z");

  const items = await system().list();
  expect(items.length).toBe(0);
});

test("9.5b entries within 48h are preserved", async () => {
  // Entry from 24 hours ago
  writeReviewEntry("bruno", "2026-05-18T12:00:00.000Z");

  const items = await system().list();
  expect(items.length).toBe(1);
});

test("9.5c entry exactly at 48h boundary is expired", async () => {
  // Entry from exactly 48 hours ago (at boundary)
  const past = new Date(frozenNow.getTime() - 48 * 60 * 60 * 1000);
  writeReviewEntry("bruno", past.toISOString());

  const items = await system().list();
  expect(items.length).toBe(0);
});

test("9.5d expired entries are deleted from disk", async () => {
  writeReviewEntry("bruno", "2026-05-16T10:00:00.000Z"); // > 48h old

  await system().list(); // triggers cleanup

  const queueDir = join(roomsDir, "bruno", "review_queue");
  if (existsSync(queueDir)) {
    const files = readdirSync(queueDir);
    expect(files.length).toBe(0);
  }
});

test("9.5e get() also triggers cleanup", async () => {
  writeReviewEntry("bruno", "2026-05-16T10:00:00.000Z"); // expired

  const entry = await system().get("bruno/2026-05-16T10-00-00-000Z");
  expect(entry).toBeNull();
});

// ---------------------------------------------------------------------------
// Domain mapping
// ---------------------------------------------------------------------------

test("domain mapping maps code -> code_review, memory -> memory_write", async () => {
  // code domain -> code_review trust
  const id1 = writeReviewEntry("bruno", "2026-05-19T10:00:00.000Z", { domain: "code" });
  const r1 = await system().approve(id1);
  expect(r1!.domain).toBe("code_review");

  // memory domain -> memory_write trust
  const id2 = writeReviewEntry("bruno", "2026-05-19T11:00:00.000Z", { domain: "memory" });
  const r2 = await system().approve(id2);
  expect(r2!.domain).toBe("memory_write");
});

// ---------------------------------------------------------------------------
// /review, /approve, /reject Telegram command tests
// ---------------------------------------------------------------------------

test("/review returns pending items", async () => {
  writeReviewEntry("bruno", "2026-05-19T10:00:00.000Z");
  const items = await system().list();
  expect(items.length).toBe(1);
  expect(items[0].id).toStartWith("bruno/");
});

test("/review with no items returns empty", async () => {
  const items = await system().list();
  expect(items.length).toBe(0);
});

test("/approve with valid id returns trust confirmation", async () => {
  const id = writeReviewEntry("bruno", "2026-05-19T10:00:00.000Z");
  const result = await system().approve(id);
  expect(result).not.toBeNull();
  expect(result!.agentId).toBe("bruno");
  expect(result!.domain).toBe("code_review");
});

test("/approve with invalid id returns null", async () => {
  const result = await system().approve("bruno/missing");
  expect(result).toBeNull();
});

test("/reject with valid id returns penalty confirmation", async () => {
  const id = writeReviewEntry("bruno", "2026-05-19T10:00:00.000Z");
  const result = await system().reject(id, "incorrect");
  expect(result).not.toBeNull();
  expect(result!.agentId).toBe("bruno");
});

test("/reject with invalid id returns null", async () => {
  const result = await system().reject("bruno/missing", "feedback");
  expect(result).toBeNull();
});
