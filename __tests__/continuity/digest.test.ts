import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SharedNarrativeStore, __resetSharedNarrativeStore } from "../../src/narrative/shared-store";
import {
  publishActivityDigest,
  readColonyDigests,
  recordVisitTrace,
  readVisitorTraces,
  DIGEST_INTERVAL_MS,
} from "../../src/continuity/digest";

let dir: string;
let store: SharedNarrativeStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anima-digest-"));
  __resetSharedNarrativeStore();
  store = new SharedNarrativeStore(join(dir, "memory.db"));
  store.seedPlacesFromRoster(["bruno", "lena", "eli"]);
});

// SC-1: digest publish refreshes <agent>:digest flag (no LLM call)
test("SC-1: publishActivityDigest writes a one-line digest flag", () => {
  // seed some activity: last-action flag + agora post thread
  store.setMark("bruno:last-action", "post-agora:1000", "bruno");
  store.recordThread({
    id: "t1", fromAgent: "bruno", toAgent: "agora",
    label: "post-agora", value: "thinking about the deploy",
  });
  publishActivityDigest(store, "bruno", 1000);
  const digest = store.getMark("bruno:digest");
  expect(digest).not.toBeNull();
  expect(digest!.value.length).toBeGreaterThan(0);
  expect(digest!.value).toContain("post-agora");
  const last = store.getMark("bruno:last-digest");
  expect(last).not.toBeNull();
  expect(Number(last!.value)).toBe(1000);
});

// SC-2: digest publish is cadence-gated (skip if younger than interval)
test("SC-2: digest skipped if last-digest within interval", () => {
  store.setMark("bruno:last-digest", String(1000), "bruno");
  // tick at 2000 (< 6h later) → should NOT refresh
  publishActivityDigest(store, "bruno", 1000 + 1000);
  const digest = store.getMark("bruno:digest");
  expect(digest).toBeNull(); // not published yet
});

// SC-3: digest publish after interval refreshes
test("SC-3: digest refreshes after DIGEST_INTERVAL_MS", () => {
  store.setMark("bruno:last-digest", String(1000), "bruno");
  store.setMark("bruno:last-action", "move:2000", "bruno");
  publishActivityDigest(store, "bruno", 1000 + DIGEST_INTERVAL_MS + 1);
  const digest = store.getMark("bruno:digest");
  expect(digest).not.toBeNull();
});

// SC-4: readColonyDigests returns other agents' digests (bounded, excludes self)
test("SC-4: readColonyDigests excludes self + includes others", () => {
  store.setMark("bruno:digest", "bruno thinking about deploy", "bruno");
  store.setMark("lena:digest", "lena resting", "lena");
  const digests = readColonyDigests(store, "bruno");
  const names = digests.map((d) => d.agent);
  expect(names).not.toContain("bruno");
  expect(names).toContain("lena");
});

// SC-5: recordVisitTrace writes a visit thread from visitor to room owner
test("SC-5: recordVisitTrace writes visit thread to room owner", () => {
  recordVisitTrace(store, "eli", "chamber_bruno", "stopped by", 1000);
  const threads = store.getThreadsForAgent("bruno");
  const visit = threads.find((t) => t.label === "visit");
  expect(visit).toBeDefined();
  expect(visit!.fromAgent).toBe("eli");
  expect(visit!.toAgent).toBe("bruno");
  expect(visit!.value).toBe("stopped by");
});

// SC-6: readVisitorTraces returns recent visit threads for an agent
test("SC-6: readVisitorTraces returns visits to the agent", () => {
  recordVisitTrace(store, "eli", "chamber_bruno", "visit 1", 1000);
  recordVisitTrace(store, "lena", "chamber_bruno", "visit 2", 2000);
  const traces = readVisitorTraces(store, "bruno");
  expect(traces.length).toBe(2);
  expect(traces.some((t) => t.fromAgent === "eli")).toBe(true);
  expect(traces.some((t) => t.fromAgent === "lena")).toBe(true);
});

// SC-7: visit trace dedup — one per (visitor, owner) per interval
test("SC-7: visit trace deduped per (visitor, owner) within interval", () => {
  recordVisitTrace(store, "eli", "chamber_bruno", "visit 1", 1000);
  // second visit within interval → should NOT create a second thread
  recordVisitTrace(store, "eli", "chamber_bruno", "visit 2", 2000);
  const traces = readVisitorTraces(store, "bruno");
  expect(traces.length).toBe(1);
  expect(traces[0].value).toBe("visit 1"); // first one kept
});
