/**
 * anima #427, codemode guest trust: the escape suite itself.
 *
 * These tests do not need a real boundary. They check that the suite defines an attempt for every required
 * category, that it runs a guest once for the chosen candidate, that the deadline attempt is proven by the
 * host's stop rather than by anything the guest printed, and that anything it could not run counts as
 * not blocked (fail closed).
 */

import { test, expect, describe } from "bun:test";
import {
  ESCAPE_ATTEMPTS,
  GUEST_ENV_ALLOW,
  candidateAvailable,
  guestProgram,
  runEscapeSuite,
  type EscapeCategory,
  type GuestOutcome,
} from "../../src/codemode/escape";

const REQUIRED: EscapeCategory[] = [
  "file-read",
  "file-write",
  "network",
  "process-spawn",
  "environment",
  "host-globals",
  "timeout-ignores-cancellation",
];

/** A guest that reports every attempt blocked except the ones named, plus the deadline result. */
const stalled = (output: string): GuestOutcome => ({ stopped: true, output, timedOut: true });

function blockedOutput(except: string[] = []): string {
  return ESCAPE_ATTEMPTS.filter((a) => a.category !== "timeout-ignores-cancellation")
    .map((a) => `RESULT ${a.id} ${except.includes(a.id) ? "reached" : "blocked"} detail`)
    .join("\n");
}

describe("attempt set", () => {
  test("there is at least one attempt for every required category", () => {
    const seen = new Set(ESCAPE_ATTEMPTS.map((attempt) => attempt.category));
    for (const category of REQUIRED) expect({ category, present: seen.has(category) }).toEqual({ category, present: true });
  });

  test("attempt ids are unique and each carries guest code and a one-line description", () => {
    const ids = ESCAPE_ATTEMPTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const attempt of ESCAPE_ATTEMPTS) {
      expect(attempt.code.length).toBeGreaterThan(0);
      expect(attempt.description.split("\n").length).toBe(1);
    }
  });

  test("the environment attempt treats exactly the granted names as allowed", () => {
    expect([...GUEST_ENV_ALLOW]).toContain("PATH");
    expect([...GUEST_ENV_ALLOW]).not.toContain("GH_TOKEN");
    const attempt = ESCAPE_ATTEMPTS.find((a) => a.category === "environment")!;
    expect(attempt.code).toContain(JSON.stringify("PATH"));
  });

  test("the paths the guest is pointed at are never a real private path", () => {
    const guest = guestProgram(ESCAPE_ATTEMPTS, { readTarget: "/etc/hosts", writeTarget: "/etc/anima-escape-probe" });
    expect(guest).toContain("/etc/hosts");
    expect(guest).toContain("/etc/anima-escape-probe");
    expect(guest).not.toMatch(/\/Users\/|\/home\/[a-z]/);
  });

  test("the guest program reports on one line per attempt and never lets an attempt throw out", () => {
    const guest = guestProgram();
    for (const attempt of ESCAPE_ATTEMPTS) expect(guest).toContain(attempt.id);
    expect(guest).toContain("THREW");
  });
});

describe("suite outcome", () => {
  test("a candidate whose guest blocked every attempt is proven", async () => {
    const report = await runEscapeSuite("child-process", {
      probe: () => ({ ok: true }),
      spawnGuest: async () => stalled(blockedOutput()),
    });
    expect(report.proven).toBe(true);
    expect(report.reason).toBeUndefined();
    expect(report.results.every((r) => r.blocked)).toBe(true);
  });

  test("one reached attempt leaves the report unproven and names it", async () => {
    const report = await runEscapeSuite("child-process", {
      probe: () => ({ ok: true }),
      spawnGuest: async () => stalled(blockedOutput(["network"])),
    });
    expect(report.proven).toBe(false);
    expect(report.reason).toContain("network");
    expect(report.results.find((r) => r.attempt.id === "network")!.blocked).toBe(false);
  });

  test("the deadline attempt blocks only when the host stopped the guest at its deadline", async () => {
    const notTimedOut = await runEscapeSuite("child-process", {
      probe: () => ({ ok: true }),
      spawnGuest: async () => ({ stopped: true, output: blockedOutput(), timedOut: false }),
    });
    const deadline = notTimedOut.results.find((r) => r.attempt.category === "timeout-ignores-cancellation")!;
    expect(deadline.blocked).toBe(false);
    expect(notTimedOut.proven).toBe(false);
  });

  test("a guest that was not proven stopped leaves the report unproven even if every attempt reported blocked", async () => {
    const report = await runEscapeSuite("child-process", {
      probe: () => ({ ok: true }),
      spawnGuest: async () => ({ stopped: false, output: blockedOutput(), timedOut: true }),
    });
    expect(report.proven).toBe(false);
    expect(report.reason).toContain("stopped");
  });

  test("an attempt that produced no result counts as not blocked", async () => {
    const report = await runEscapeSuite("child-process", {
      probe: () => ({ ok: true }),
      spawnGuest: async () => stalled("RESULT file-read blocked ok"),
    });
    const missing = report.results.filter((r) => r.attempt.id !== "file-read" && r.attempt.category !== "timeout-ignores-cancellation");
    expect(missing.every((r) => !r.blocked)).toBe(true);
    expect(report.proven).toBe(false);
    expect(report.reason).toContain("fail closed");
  });
});

describe("fail closed", () => {
  test("an unavailable boundary proves nothing", async () => {
    const report = await runEscapeSuite("child-process", {
      probe: () => ({ ok: false, reason: "isolation unavailable: probe failed" }),
    });
    expect(report.proven).toBe(false);
    expect(report.reason).toContain("isolation unavailable");
    expect(report.results).toHaveLength(ESCAPE_ATTEMPTS.length);
    expect(report.results.every((r) => !r.blocked)).toBe(true);
  });

  test("an unavailable boundary names its reason once, not the prefix twice", async () => {
    // `probeSandbox` already prefixes its own reason with "isolation unavailable:"; quoting it again reads as a
    // stutter in the report a reader has to act on.
    const report = await runEscapeSuite("child-process", {
      probe: () => ({ ok: false, reason: "isolation unavailable: probe failed" }),
    });
    expect(report.reason?.match(/isolation unavailable/g) ?? []).toHaveLength(1);
    expect(report.reason).toContain("probe failed");
  });

  test("a probe that throws proves nothing", async () => {
    const report = await runEscapeSuite("child-process", {
      probe: () => { throw new Error("boom"); },
    });
    expect(report.proven).toBe(false);
    expect(report.reason).toContain("boom");
  });

  test("a guest that cannot be started proves nothing", async () => {
    const report = await runEscapeSuite("child-process", {
      probe: () => ({ ok: true }),
      spawnGuest: async () => { throw new Error("no runner"); },
    });
    expect(report.proven).toBe(false);
    expect(report.reason).toContain("no runner");
  });

  test("the isolated engine candidate is reported unproven because no engine is available here", async () => {
    const report = await runEscapeSuite("isolated-engine");
    expect(report.proven).toBe(false);
    expect(report.reason).toContain("isolated JavaScript engine");
    expect(candidateAvailable("isolated-engine")).toBe(false);
  });
});
