import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CommitmentCandidateSource, GardenEventCandidateSource, StewardshipCandidateSource, WorkCandidateSource } from "./candidate-sources";
import { ActivationStore } from "./activation-store";

test("SC-014 rejects a commitment without trusted authority and SC-015 emits a due accepted one", () => {
  const source = new CommitmentCandidateSource();
  expect(source.add({ id: "c1", agentId: "eli", sourceRef: "note:1", authorityRef: "", description: "invented", acceptedAt: 1, nextReviewAt: 1 })).toEqual({ ok: false, reason: "untrusted" });
  expect(source.add({ id: "c2", agentId: "eli", sourceRef: "note:2", authorityRef: "user:owner", description: "review", acceptedAt: 1, nextReviewAt: 10 })).toEqual({ ok: true });
  expect(source.dueCandidates(10)[0]?.requiredPlace).toBeUndefined();
  expect(source.dueCandidates(10)[0]?.reasonRef).toBe("note:2");
});

test("accepted commitment survives store reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "commitment-source-"));
  const path = join(dir, "memory.db");
  const store = new ActivationStore(path);
  new CommitmentCandidateSource(store).add({ id: "c1", agentId: "eli", sourceRef: "note:1", authorityRef: "user:owner", description: "review", acceptedAt: 1, nextReviewAt: 10 });
  store.close();
  const reopened = new ActivationStore(path);
  try {
    expect(new CommitmentCandidateSource(reopened).dueCandidates(10)).toHaveLength(1);
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SC-026 keeps recurrence identity distinct per review time", () => {
  const source = new CommitmentCandidateSource();
  source.add({ id: "c1", agentId: "eli", sourceRef: "note:1", authorityRef: "user:owner", description: "review", acceptedAt: 1, nextReviewAt: 10 });
  const first = source.dueCandidates(10)[0]!;
  source.add({ id: "c1", agentId: "eli", sourceRef: "note:1", authorityRef: "user:owner", description: "review", acceptedAt: 1, nextReviewAt: 20 });
  const second = source.dueCandidates(20)[0]!;
  expect(second.occurrenceKey).not.toBe(first.occurrenceKey);
});

test("SC-016 creates one durable stewardship review occurrence", () => {
  const source = new StewardshipCandidateSource();
  source.add({ id: "s1", agentId: "eli", scopeRef: "garden:bridge", responsibility: "review bridge", cadenceMs: 100, nextReviewAt: 10 });
  const first = source.dueCandidates(10);
  expect(first).toHaveLength(1);
  expect(source.dueCandidates(10)[0]?.key).toBe(first[0]?.key);
});

test("SC-017 records a no-action stewardship review without provider work", () => {
  const source = new StewardshipCandidateSource();
  source.add({ id: "s1", agentId: "eli", scopeRef: "garden:bridge", responsibility: "review bridge", cadenceMs: 100, nextReviewAt: 10 });
  const occurrence = source.dueCandidates(10)[0]!;
  expect(source.recordReview(occurrence, 10, "no-action")).toEqual({ ok: true });
  expect(source.dueCandidates(10)).toEqual([]);
  const next = source.dueCandidates(110)[0]!;
  expect(next.occurrenceKey).not.toBe(occurrence.occurrenceKey);
});

test("SC-018 derives a workshop candidate from canonical work without owning a copy", () => {
  const source = new WorkCandidateSource(() => [{ id: "work-1", agentId: "eli", ref: "castle-activation-broker", title: "Implement broker", status: "claimed", updatedAt: 10 }]);
  expect(source.candidates()).toEqual([expect.objectContaining({
    sourceKind: "work", sourceRef: "work:work-1", reasonRef: "work:work-1", requiredPlace: "workshop", costClass: "T2",
  })]);
});

test("SC-018 schema-unavailable work adapter stays disabled", () => {
  expect(new WorkCandidateSource().candidates()).toEqual([]);
});

test("SC-019 ignores an event outside the explicit candidate-source allowlist", () => {
  expect(new GardenEventCandidateSource().candidatesFromEvents([{ type: "AUTONOMY_CHANGE", payload: {} }])).toEqual([]);
});
