import { describe, expect, test } from "bun:test";
import { formatIntentTarget, INTENT_REVIEW_ENV, intentRevision, parseIntentTarget, ReviewBudgets } from "../../src/tools/review-budget";

const REPO = "rfcclub/anima";
const comment = (issue = 299) => ({ action: "issue_comment", repo: REPO, issue });
const approve = (issue = 299) => ({ action: "approve_intent", repo: REPO, issue });

describe("ReviewBudgets", () => {
  test("SC-011 no budget: everything is admitted and nothing is counted", () => {
    const b = new ReviewBudgets();
    expect(b.active("cleo")).toBeUndefined();
    for (let i = 0; i < 10; i++) expect(b.admit("cleo", comment())).toEqual({ ok: true });
  });

  test("SC-001 the first verdict is admitted, the next comment is refused", () => {
    const b = new ReviewBudgets();
    b.begin("cleo", { repo: REPO, issue: 299 });
    expect(b.admit("cleo", comment())).toEqual({ ok: true });
    b.commit("cleo");
    expect(b.admit("cleo", comment())).toEqual({ ok: false, reason: "verdict-recorded" });
  });

  test("SC-002 a comment after an approval is refused", () => {
    const b = new ReviewBudgets();
    b.begin("cleo", { repo: REPO, issue: 299 });
    expect(b.admit("cleo", approve())).toEqual({ ok: true });
    b.commit("cleo");
    expect(b.admit("cleo", comment())).toEqual({ ok: false, reason: "verdict-recorded" });
  });

  test("SC-003 an approval after a comment is refused", () => {
    const b = new ReviewBudgets();
    b.begin("cleo", { repo: REPO, issue: 299 });
    expect(b.admit("cleo", comment())).toEqual({ ok: true });
    b.commit("cleo");
    expect(b.admit("cleo", approve())).toEqual({ ok: false, reason: "verdict-recorded" });
  });

  test("SC-004 three failed attempts use the budget up; the fourth is refused", () => {
    const b = new ReviewBudgets();
    b.begin("cleo", { repo: REPO, issue: 299 });
    for (let i = 0; i < 3; i++) { expect(b.admit("cleo", comment())).toEqual({ ok: true }); b.release("cleo"); }
    expect(b.admit("cleo", comment())).toEqual({ ok: false, reason: "attempt-limit" });
  });

  test("SC-005 a failure followed by a success; the third call is refused as recorded", () => {
    const b = new ReviewBudgets();
    b.begin("cleo", { repo: REPO, issue: 299 });
    expect(b.admit("cleo", comment())).toEqual({ ok: true }); // fails upstream, nothing recorded
    b.release("cleo");
    expect(b.admit("cleo", comment())).toEqual({ ok: true });
    b.commit("cleo");
    expect(b.admit("cleo", comment())).toEqual({ ok: false, reason: "verdict-recorded" });
  });

  test("SC-006 another issue is not allowed and costs no attempt", () => {
    const b = new ReviewBudgets();
    b.begin("cleo", { repo: REPO, issue: 299 });
    expect(b.admit("cleo", comment(300))).toEqual({ ok: false, reason: "not-allowed" });
    expect(b.admit("cleo", { action: "issue_comment", repo: "rfcclub/other", issue: 299 })).toEqual({ ok: false, reason: "not-allowed" });
    expect(b.active("cleo")!.attemptsLeft).toBe(3);
  });

  test("SC-007 other actions are not allowed and cost no attempt", () => {
    const b = new ReviewBudgets();
    b.begin("cleo", { repo: REPO, issue: 299 });
    for (const action of ["issue_create", "pr_create", "push", "review", "review_threads", "review_reply", "review_resolve", "nonsense"]) {
      expect(b.admit("cleo", { action, repo: REPO, issue: 299 })).toEqual({ ok: false, reason: "not-allowed" });
    }
    expect(b.active("cleo")!.attemptsLeft).toBe(3);
  });

  test("refund gives the verdict and, once only, the attempt back", () => {
    const b = new ReviewBudgets();
    b.begin("cleo", { repo: REPO, issue: 299 });
    b.admit("cleo", comment());
    expect(b.active("cleo")).toMatchObject({ attemptsLeft: 2, verdictsLeft: 0 });
    b.refund("cleo");
    expect(b.active("cleo")).toMatchObject({ attemptsLeft: 3, verdictsLeft: 1 });
    b.admit("cleo", comment());
    b.refund("cleo"); // a repeated duplicate keeps costing: the one refund is spent
    expect(b.active("cleo")).toMatchObject({ attemptsLeft: 2, verdictsLeft: 1 });
  });

  test("a repeated duplicate cannot go on forever (attempts run out)", () => {
    const b = new ReviewBudgets();
    b.begin("cleo", { repo: REPO, issue: 299 });
    let admitted = 0;
    while (b.admit("cleo", comment()).ok) { admitted++; b.refund("cleo"); if (admitted > 20) break; }
    expect(admitted).toBe(4); // 3 attempts plus the one refunded
    expect(b.admit("cleo", comment())).toEqual({ ok: false, reason: "attempt-limit" });
  });

  test("a call in flight holds the verdict: a second concurrent call is refused until the first fails", () => {
    const b = new ReviewBudgets();
    b.begin("cleo", { repo: REPO, issue: 299 });
    expect(b.admit("cleo", comment())).toEqual({ ok: true });
    expect(b.admit("cleo", approve())).toEqual({ ok: false, reason: "verdict-recorded" });
    b.release("cleo"); // the first call failed without writing
    expect(b.admit("cleo", approve())).toEqual({ ok: true });
  });

  test("a budget is per agent", () => {
    const b = new ReviewBudgets();
    b.begin("cleo", { repo: REPO, issue: 299 });
    b.admit("cleo", comment()); b.commit("cleo");
    expect(b.admit("pia", comment())).toEqual({ ok: true });
    expect(b.active("pia")).toBeUndefined();
  });

  test("SC-008 release removes the budget", () => {
    const b = new ReviewBudgets();
    const release = b.begin("cleo", { repo: REPO, issue: 299 });
    expect(b.active("cleo")).toBeDefined();
    release();
    expect(b.active("cleo")).toBeUndefined();
    release(); // idempotent
    expect(b.active("cleo")).toBeUndefined();
  });

  test("SC-019 a new turn gets a fresh budget; the earlier release cannot remove it", () => {
    const b = new ReviewBudgets();
    const first = b.begin("cleo", { repo: REPO, issue: 299 });
    b.admit("cleo", comment()); b.commit("cleo");
    const second = b.begin("cleo", { repo: REPO, issue: 299 });
    expect(b.active("cleo")).toMatchObject({ verdictsLeft: 1, attemptsLeft: 3 });
    first(); // a stuck earlier turn ends late
    expect(b.active("cleo")).toMatchObject({ verdictsLeft: 1, attemptsLeft: 3 });
    second();
    expect(b.active("cleo")).toBeUndefined();
  });

  test("commit, release and refund with no budget are no-ops", () => {
    const b = new ReviewBudgets();
    expect(() => { b.commit("cleo"); b.release("cleo"); b.refund("cleo"); }).not.toThrow();
  });

  describe("the child adopts its budget from the environment", () => {
    const withEnv = (value?: string) => new ReviewBudgets(() => (value === undefined ? {} : { [INTENT_REVIEW_ENV]: value }));

    test("a child told the issue gets a fresh budget on its first call", () => {
      const b = withEnv("rfcclub/anima#299");
      expect(b.active("cleo")).toBeUndefined();
      b.adoptFromEnv("cleo");
      expect(b.active("cleo")).toEqual({ repo: REPO, issue: 299, verdictsLeft: 1, attemptsLeft: 3 });
    });

    test("it adopts once: a used-up budget is never refilled by calling again", () => {
      const b = withEnv("rfcclub/anima#299");
      b.adoptFromEnv("cleo");
      b.admit("cleo", comment()); b.commit("cleo");
      b.adoptFromEnv("cleo");
      expect(b.active("cleo")).toMatchObject({ verdictsLeft: 0 });
    });

    test("SC-011 no variable, no budget", () => {
      const b = withEnv();
      b.adoptFromEnv("cleo");
      expect(b.active("cleo")).toBeUndefined();
    });

    test("a malformed or foreign value gives no budget (never a wrong one)", () => {
      for (const bad of ["", "299", "rfcclub/anima#0", "rfcclub/anima#-1", "rfcclub/anima#12x", "other/repo#5", "rfcclub/anima 5", "rfcclub/anima#299\nX"]) {
        const b = withEnv(bad);
        b.adoptFromEnv("cleo");
        expect(b.active("cleo")).toBeUndefined();
      }
    });

    test("the revision rides along and is validated", () => {
      const b = withEnv("rfcclub/anima#299@0123456789ab");
      b.adoptFromEnv("cleo");
      expect(b.active("cleo")).toMatchObject({ issue: 299, revision: "0123456789ab" });
      for (const bad of ["rfcclub/anima#299@", "rfcclub/anima#299@XYZ", "rfcclub/anima#299@0123456789abc"]) expect(parseIntentTarget(bad)).toBeNull();
      expect(parseIntentTarget(formatIntentTarget({ repo: REPO, issue: 5, revision: "0123456789ab" }))).toEqual({ repo: REPO, issue: 5, revision: "0123456789ab" });
    });

    test("the revision hash follows the title and the body", () => {
      expect(intentRevision("t", "b")).toMatch(/^[0-9a-f]{12}$/);
      expect(intentRevision("t", "b")).toBe(intentRevision("t", "b"));
      expect(intentRevision("t", "b")).not.toBe(intentRevision("t", "b2"));
      expect(intentRevision("t", "b")).not.toBe(intentRevision("t2", "b"));
    });

    test("format and parse round-trip", () => {
      expect(parseIntentTarget(formatIntentTarget({ repo: REPO, issue: 299 }))).toEqual({ repo: REPO, issue: 299 });
    });
  });
});
