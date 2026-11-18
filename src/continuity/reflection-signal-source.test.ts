import { test, expect } from "bun:test";
import { ReflectionSignalCandidateSource } from "./reflection-signal-source";

test("SC-066: unread inbox produces a due reflection candidate with heuristic urgency", () => {
  const source = new ReflectionSignalCandidateSource();
  const candidate = source.buildCandidate({ agentId: "bruno", inboxCount: 2, knocked: false, now: 10_000 });

  expect(candidate).not.toBeNull();
  expect(candidate!.executor).toBe("reflection");
  expect(candidate!.agentId).toBe("bruno");
  expect(candidate!.urgency).toBe(5); // min(5, 2 * 3) = 5
  expect(candidate!.dueAt).toBe(10_000);
});

test("SC-066b: inbox urgency is capped at 5 regardless of count", () => {
  const source = new ReflectionSignalCandidateSource();
  const candidate = source.buildCandidate({ agentId: "bruno", inboxCount: 8, knocked: false, now: 10_000 });

  expect(candidate!.urgency).toBe(5); // min(5, 8 * 3) = 5
});

test("SC-067: pending knock produces a due reflection candidate with the knock bonus", () => {
  const source = new ReflectionSignalCandidateSource();
  const candidate = source.buildCandidate({ agentId: "bruno", inboxCount: 0, knocked: true, now: 10_000 });

  expect(candidate).not.toBeNull();
  expect(candidate!.executor).toBe("reflection");
  expect(candidate!.urgency).toBe(5);
});

test("SC-067b: inbox and knock urgency combine", () => {
  const source = new ReflectionSignalCandidateSource();
  const candidate = source.buildCandidate({ agentId: "bruno", inboxCount: 1, knocked: true, now: 10_000 });

  expect(candidate!.urgency).toBe(8); // min(5, 1*3)=3 + 5
});

test("SC-068: no signal produces no candidate", () => {
  const source = new ReflectionSignalCandidateSource();
  const candidate = source.buildCandidate({ agentId: "bruno", inboxCount: 0, knocked: false, now: 10_000 });

  expect(candidate).toBeNull();
});

test("restlessness: idle under threshold produces no candidate", () => {
  const source = new ReflectionSignalCandidateSource();
  const candidate = source.buildCandidate({
    agentId: "finn", inboxCount: 0, knocked: false, now: 10_000, hoursSinceLastMove: 3,
  });

  expect(candidate).toBeNull();
});

test("restlessness: idle past threshold with no other signal produces a candidate", () => {
  const source = new ReflectionSignalCandidateSource();
  const candidate = source.buildCandidate({
    agentId: "finn", inboxCount: 0, knocked: false, now: 10_000, hoursSinceLastMove: 7,
  });

  expect(candidate).not.toBeNull();
  expect(candidate!.urgency).toBe(2);
});

test("restlessness: grows with idle time and caps at 6", () => {
  const source = new ReflectionSignalCandidateSource();
  const at12h = source.buildCandidate({
    agentId: "finn", inboxCount: 0, knocked: false, now: 10_000, hoursSinceLastMove: 12,
  });
  const at100h = source.buildCandidate({
    agentId: "finn", inboxCount: 0, knocked: false, now: 10_000, hoursSinceLastMove: 100,
  });

  expect(at12h!.urgency).toBe(4);
  expect(at100h!.urgency).toBe(6);
});

test("restlessness: clears the default urgencyThreshold (3) with margin once ramped, unlike the old cap==threshold tuning", () => {
  const source = new ReflectionSignalCandidateSource();
  // Daytime (America/New_York): 2026-08-03T16:00:00Z = 12:00 EDT.
  const daytimeNow = Date.UTC(2026, 7, 3, 16, 0, 0);
  const candidate = source.buildCandidate({
    agentId: "finn", inboxCount: 0, knocked: false, now: daytimeNow, hoursSinceLastMove: 18,
  });

  expect(candidate!.urgency).toBe(6);
  expect(candidate!.urgency).toBeGreaterThan(3); // clears default threshold with real headroom
});

test("restlessness: suppressed at night even when fully idle (agents 'sleep', mail/knock still work)", () => {
  const source = new ReflectionSignalCandidateSource();
  // Night (America/New_York): 2026-08-03T06:00:00Z = 02:00 EDT.
  const nightNow = Date.UTC(2026, 7, 3, 6, 0, 0);
  const restOnly = source.buildCandidate({
    agentId: "finn", inboxCount: 0, knocked: false, now: nightNow, hoursSinceLastMove: 100,
  });
  const withKnock = source.buildCandidate({
    agentId: "finn", inboxCount: 0, knocked: true, now: nightNow, hoursSinceLastMove: 100,
  });

  expect(restOnly).toBeNull();
  expect(withKnock).not.toBeNull();
  expect(withKnock!.urgency).toBe(5); // knock bonus only — no restlessness contribution at night
});

test("restlessness: missing hoursSinceLastMove never contributes urgency on its own", () => {
  const source = new ReflectionSignalCandidateSource();
  const candidate = source.buildCandidate({
    agentId: "finn", inboxCount: 0, knocked: false, now: 10_000, hoursSinceLastMove: null,
  });

  expect(candidate).toBeNull();
});

test("restlessness combines additively with inbox/knock urgency", () => {
  const source = new ReflectionSignalCandidateSource();
  const candidate = source.buildCandidate({
    agentId: "bruno", inboxCount: 1, knocked: false, now: 10_000, hoursSinceLastMove: 12,
  });

  expect(candidate!.urgency).toBe(7); // min(5, 1*3)=3 + restlessness(12h)=4
});

test("candidate key is stable per agent+tick, distinct across ticks", () => {
  const source = new ReflectionSignalCandidateSource();
  const a = source.buildCandidate({ agentId: "bruno", inboxCount: 1, knocked: false, now: 10_000 });
  const b = source.buildCandidate({ agentId: "bruno", inboxCount: 1, knocked: false, now: 20_000 });

  expect(a!.key).toBeTruthy();
  expect(a!.key).not.toBe(b!.key);
});
