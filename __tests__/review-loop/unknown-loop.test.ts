import { expect, test } from "bun:test";
import { auditReviewEligibility } from "../../src/review-loop/eligibility";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NOW = 1_000_000;
const options = () => ({
  apps: { eli: "eli[bot]", bruno: "bruno[bot]" },
  bindings: [{ reviewId: 1, headSha: HEAD, baseSha: BASE, appLogin: "bruno[bot]" }],
  now: NOW,
  cooldownMs: 1_000,
});
function candidate() {
  return {
    repo: "rfcclub/anima", number: 1, state: "OPEN", draft: false,
    headSha: HEAD, baseSha: BASE, observedHeadSha: HEAD, observedBaseSha: BASE,
    ownerAgents: ["eli"], authorLogin: "eli[bot]",
    paths: { complete: true, items: [{ path: "src/example.ts" }] },
    commits: { complete: true, items: [
      { sha: HEAD, authorLogin: "eli[bot]", committerLogin: "eli[bot]", message: "fix\n\nAgent: eli" },
    ] },
    reviews: { complete: true, items: [
      { id: 1, appLogin: "bruno[bot]", state: "APPROVED", headSha: HEAD, body: "Reviewer: bruno\nNo findings", submittedAt: 10 },
    ] },
    threads: { complete: true, items: [] as { resolved: boolean }[] },
    ci: { complete: true, configured: true as boolean | null, headSha: HEAD, results: ["SUCCESS"] },
    issue: { number: 45, type: "enhancement", approved: true },
    loop: { complete: true, rounds: 1, lastAttemptAt: 0 },
  };
}

const reasons = (value: unknown) => {
  const r = auditReviewEligibility(value, options());
  expect(r.automaticMerge).toBe(false);
  return r.reasons;
};
test("EA-1 explicit unknown loop is unproven rather than malformed or invented timing", () => {
  expect(reasons({ ...candidate(), loop: null })).toEqual(["atomic_base_guard_unproven", "loop_state_unproven"]);
});
test.each([undefined, {}, [], 0, false, { complete: true, rounds: 1 },
  { complete: true, rounds: "1", lastAttemptAt: 0 }, { complete: null, rounds: 1, lastAttemptAt: 0 }].map(loop => ({ loop })))
("EA-1 malformed loop %j is not accepted as unknown", ({ loop }) => {
  expect(reasons({ ...candidate(), loop })).toContain("malformed_snapshot");
});
test("EA-1 missing loop is malformed", () => {
  const { loop, ...rest } = candidate();
  expect(reasons(rest)).toContain("malformed_snapshot");
});
test("EA-1 null loop never discards independent policy refusals", () => {
  const c = { ...candidate(), loop: null, ownerAgents: [], issue: null };
  c.ci.results = ["FAILURE"];
  c.threads.items.push({ resolved: false });
  expect(reasons(c)).toEqual(["atomic_base_guard_unproven", "ci_not_green", "foreign_commit", "intent_unverified",
    "loop_state_unproven", "owner_unverified", "unresolved_thread"]);
});
test("EA-1 known loop still preserves round limit and cooldown", () => {
  const c = candidate(); c.loop.rounds = 4; c.loop.lastAttemptAt = NOW;
  expect(reasons(c)).toEqual(["atomic_base_guard_unproven", "cooldown", "round_limit"]);
});
test("EA-1 known complete loop baseline remains unchanged", () => {
  expect(reasons(candidate())).toEqual(["atomic_base_guard_unproven"]);
});
