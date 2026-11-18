import { describe, test, expect, beforeEach } from "bun:test";
import { MaturationLedger, type MaturationStatus } from "../../src/continuity/maturation";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "anima-maturation-test-"));
}

describe("MaturationLedger", () => {
  let ledger: MaturationLedger;

  beforeEach(() => {
    ledger = new MaturationLedger();
  });

  test("read returns default gentle profile when no file", async () => {
    const dir = tempDir();
    const status = await ledger.read(dir);
    expect(status.profile).toBe("gentle");
    expect(status.stage).toBe("accumulating");
    expect(status.sessionsCompleted).toBe(0);
  });

  test("write and read round-trip", async () => {
    const dir = tempDir();
    const status: MaturationStatus = {
      profile: "gentle",
      stage: "accumulating",
      sessionsCompleted: 5,
      milestonesCompleted: ["first-crossing"],
      nextMilestone: "ten-sessions",
      peerReviewsReceived: 0,
    };
    await ledger.write(dir, status);
    const read = await ledger.read(dir);
    expect(read.profile).toBe("gentle");
    expect(read.sessionsCompleted).toBe(5);
    expect(read.milestonesCompleted).toContain("first-crossing");
  });

  test("recordSession increments session count", async () => {
    const dir = tempDir();
    const result = await ledger.recordSession(dir);
    expect(result.advanced).toBe(false);

    const status = await ledger.read(dir);
    expect(status.sessionsCompleted).toBe(1);
  });

  test("recordPeerReview increments peer review count", async () => {
    const dir = tempDir();
    await ledger.recordPeerReview(dir);
    const status = await ledger.read(dir);
    expect(status.peerReviewsReceived).toBe(1);
  });

  test("auto-completes milestone when requirements met", async () => {
    const dir = tempDir();
    // first-crossing requires 1 session
    const result = await ledger.recordSession(dir);
    expect(result.advanced).toBe(false);

    const status = await ledger.read(dir);
    expect(status.milestonesCompleted).toContain("first-crossing");
  });

  test("advances profile when all milestones complete", async () => {
    const dir = tempDir();
    // Write a near-complete gentle profile
    const nearComplete: MaturationStatus = {
      profile: "gentle",
      stage: "accumulating",
      sessionsCompleted: 20,
      milestonesCompleted: ["first-crossing", "ten-sessions", "first-peer-review"],
      nextMilestone: "gentle-complete",
      peerReviewsReceived: 3,
    };
    await ledger.write(dir, nearComplete);

    // One more session should complete gentle-complete
    await ledger.recordSession(dir);
    const status = await ledger.read(dir);
    expect(status.profile).toBe("standard");
    expect(status.stage).toBe("established");
  });

  test("full profile stays full", async () => {
    const dir = tempDir();
    const fullStatus: MaturationStatus = {
      profile: "full",
      stage: "mature",
      sessionsCompleted: 150,
      milestonesCompleted: ["hundred-sessions", "peer-review-20"],
      nextMilestone: null,
      peerReviewsReceived: 25,
    };
    await ledger.write(dir, fullStatus);

    const result = await ledger.recordSession(dir);
    expect(result.advanced).toBe(false);
    const status = await ledger.read(dir);
    expect(status.profile).toBe("full");
  });
});
