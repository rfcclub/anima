import { describe, expect, test } from "bun:test";
import { auditReviewEligibility, classifyReviewPath } from "../../src/review-loop/eligibility";
import policy from "../../data/pr-review-policy.json";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OTHER = "c".repeat(40);
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
type Candidate = ReturnType<typeof candidate>;
function reasons(value: unknown, opts = options()) {
  const result = auditReviewEligibility(value, opts);
  expect(result.automaticMerge).toBe(false);
  return result.reasons;
}

test("RE-1 src approval still requires human merge in this read-only slice", () => {
  expect(reasons(candidate())).toEqual(["atomic_base_guard_unproven"]);
});

describe("RE-2 exact reviewed path policy", () => {
  test("policy lists are exactly parent SC-024", () => {
    expect(policy).toEqual({
      autoMerge: ["src/**", "packages/**", "scripts/**", "__tests__/**"],
      humanOnly: [".github/**", "**/intent.md", "src/tools/policy-enforcer.ts",
        "packages/identity-runtime/src/bruno-recall-policy.ts", "scripts/anima.env",
        "**/*.env*", "**/*.pem", "**/*secret*", "**/*credential*"],
    });
  });
  for (const path of ["src/a.ts", "packages/a/index.ts", "scripts/a.sh", "__tests__/a.test.ts"]) {
    test(`allows code class ${path}`, () => expect(classifyReviewPath(path)).toBe("code"));
  }
  for (const path of [
    ".github/workflows/a.yml", "intent.md", "openspec/change/intent.md",
    "src/tools/policy-enforcer.ts", "packages/identity-runtime/src/bruno-recall-policy.ts",
    "scripts/anima.env", "src/a.env.local", "src/key.pem", "src/secret-store.ts",
    "src/nested/credential.json", "docs/a.md", "openspec/spec.md", "data/pr-review-policy.json",
  ]) {
    test(`refuses human/unclassified ${path}`, () => expect(classifyReviewPath(path)).toBe("human"));
  }
  for (const path of ["", "/src/a.ts", "src/../a.ts", "src/./a.ts", "src//a.ts", "src\\a.ts", "src/a\n.ts", "src/"]) {
    test(`refuses noncanonical ${JSON.stringify(path)}`, () => expect(classifyReviewPath(path)).toBe("invalid"));
  }
  test("both sides of a rename must be permitted", () => {
    const value = candidate();
    value.paths.items = [{ path: "src/a.ts", previousPath: ".github/workflows/a.yml" } as any];
    expect(reasons(value)).toContain("human_path");
    value.paths.items = [{ path: "docs/a.md", previousPath: "src/a.ts" } as any];
    expect(reasons(value)).toContain("human_path");
  });
  for (const path of [
    "src/CredentialStore.ts", "src/Secrets.ts", "src/SECRET.ts", "src/.ENV",
    "scripts/ANIMA.ENV", "src/a/MY.PEM", "src/tools/Policy-Enforcer.ts",
    "packages/identity-runtime/src/Bruno-Recall-Policy.ts", "src/a/INTENT.MD",
  ]) {
    test(`regression: case-insensitive human-only path ${path}`, () => {
      expect(classifyReviewPath(path)).toBe("human");
      const value = candidate(); value.paths.items = [{ path }];
      expect(reasons(value)).toContain("human_path");
    });
  }
  test("mixed-case human-only rename source remains human", () => {
    const value = candidate();
    value.paths.items = [{ path: "src/ordinary.ts", previousPath: "scripts/ANIMA.ENV" } as any];
    expect(reasons(value)).toContain("human_path");
  });
  test("autoMerge directory allowlist stays case-sensitive", () => {
    expect(classifyReviewPath("SRC/ordinary.ts")).toBe("human");
    expect(classifyReviewPath("src/Ordinary.ts")).toBe("code");
  });
});

describe("RE-3 complete stable snapshot", () => {
  for (const collection of ["paths", "commits", "reviews", "threads", "ci"] as const) {
    test(`incomplete ${collection} is not absence of a blocker`, () => {
      const value = candidate(); value[collection].complete = false;
      expect(reasons(value)).toContain(`incomplete_${collection}`);
    });
  }
  for (const field of ["headSha", "baseSha", "observedHeadSha", "observedBaseSha"] as const) {
    test(`refuses malformed full SHA ${field}`, () => {
      const value = candidate(); value[field] = HEAD.slice(0, 7);
      expect(reasons(value)).toContain("malformed_snapshot");
    });
  }
  test("refuses collection-time head movement", () => {
    const value = candidate(); value.observedHeadSha = OTHER;
    expect(reasons(value)).toContain("snapshot_moved");
  });
  test("base movement refuses regardless of ancestry; no Git graph is claimed by this fixture", () => {
    const value = candidate(); value.observedBaseSha = OTHER;
    expect(reasons(value)).toContain("snapshot_moved");
  });
  for (const value of [null, {}, [], { ...candidate(), paths: { complete: true, items: null } }]) {
    test(`malformed input ${JSON.stringify(value)?.slice(0, 35)}`, () => {
      expect(reasons(value)).toContain("malformed_snapshot");
    });
  }
  test("regression: oversized collection refuses before evaluating its members", () => {
    const value = candidate();
    value.paths.items = Array.from({ length: 10_001 }, () => ({ path: "src/a.ts" }));
    expect(reasons(value)).toContain("malformed_snapshot");
  });
  test("regression: oversized review prose refuses without echoing it", () => {
    const value = candidate();
    value.reviews.items[0]!.body = "s".repeat(65_537);
    const result = auditReviewEligibility(value, options());
    expect(result.reasons).toContain("malformed_snapshot");
    expect(JSON.stringify(result)).not.toContain("ssss");
  });
  for (const field of ["paths", "commits"] as const) {
    test(`empty ${field} is not accepted evidence`, () => {
      const value = candidate(); value[field].items = [];
      expect(reasons(value)).toContain(`empty_${field}`);
    });
  }
  test("closed and draft candidates are refused", () => {
    const value = candidate(); value.state = "CLOSED"; value.draft = true;
    expect(reasons(value)).toEqual(expect.arrayContaining(["not_open", "draft"]));
  });
});

describe("RE-4 author and reviewer App binding", () => {
  for (const ownerAgents of [[], ["eli", "bruno"], ["unknown"]]) {
    test(`owner set ${JSON.stringify(ownerAgents)} refuses`, () => {
      const value = candidate(); value.ownerAgents = ownerAgents;
      expect(reasons(value)).toContain("owner_unverified");
    });
  }
  test("PR author must match the registered owner App", () => {
    const value = candidate(); value.authorLogin = "someone";
    expect(reasons(value)).toContain("owner_unverified");
  });
  for (const field of ["authorLogin", "committerLogin", "message"] as const) {
    test(`all commits require author identity/trailer: ${field}`, () => {
      const value = candidate(); value.commits.items[0]![field] = "someone";
      expect(reasons(value)).toContain("foreign_commit");
    });
  }
  test("a later foreign commit is checked too", () => {
    const value = candidate();
    value.commits.items.push({ ...value.commits.items[0]!, sha: OTHER, authorLogin: "bruno[bot]" });
    expect(reasons(value)).toContain("foreign_commit");
  });
  test("complete commit evidence must include the current head", () => {
    const value = candidate(); value.commits.items[0]!.sha = OTHER;
    expect(reasons(value)).toContain("head_commit_missing");
  });
  test("duplicate commit SHAs are ambiguous evidence", () => {
    const value = candidate(); value.commits.items.push({ ...value.commits.items[0]! });
    expect(reasons(value)).toContain("commit_evidence_ambiguous");
  });
  test("unauthorized author App review cannot authorize its PR", () => {
    const value = candidate(); value.reviews.items[0]!.appLogin = "eli[bot]";
    expect(reasons(value)).toContain("approval_missing");
  });
  test.each(["Reviewer: eli", "Reviewer: unknown", "Reviewer: bruno-evil", "No findings", "Reviewer: bruno\nReviewer: eli"])(
    "unauthorized review tag refuses %j", body => {
      const value = candidate(); value.reviews.items[0]!.body = body;
      expect(reasons(value)).toContain("reviewer_unverified");
    },
  );
  test("forbidden forged reviewer tag cannot impersonate a different App", () => {
    const value = candidate(); value.reviews.items[0]!.appLogin = "unknown[bot]";
    expect(reasons(value)).toContain("reviewer_unverified");
  });
  test("duplicate registry login refuses rather than guessing", () => {
    const opts = options(); opts.apps.bruno = opts.apps.eli;
    expect(reasons(candidate(), opts)).toContain("registry_invalid");
  });
  test("registered identities compare case-insensitively", () => {
    const value = candidate(); value.authorLogin = "ELI[bot]";
    value.reviews.items[0]!.appLogin = "BRUNO[bot]";
    expect(reasons(value)).toEqual(["atomic_base_guard_unproven"]);
  });
});

describe("RE-5 current latest review and trusted base receipt", () => {
  test("duplicate review IDs refuse in either array order", () => {
    const value = candidate();
    value.reviews.items.push({ ...value.reviews.items[0]!, state: "CHANGES_REQUESTED" });
    expect(reasons(value)).toContain("review_evidence_ambiguous");
    value.reviews.items.reverse();
    expect(reasons(value)).toContain("review_evidence_ambiguous");
  });
  test("old head approval is not current evidence", () => {
    const value = candidate(); value.reviews.items[0]!.headSha = OTHER;
    expect(reasons(value)).toContain("approval_missing");
  });
  test("body text cannot supply the missing trusted base receipt", () => {
    const value = candidate(); value.reviews.items[0]!.body += `\nBase-SHA: ${BASE}`;
    const opts = options(); opts.bindings = [];
    expect(reasons(value, opts)).toContain("review_base_unbound");
  });
  test("ambiguous duplicate trusted receipts are refused", () => {
    const opts = options(); opts.bindings.push({ ...opts.bindings[0]! });
    expect(reasons(candidate(), opts)).toContain("review_base_unbound");
  });
  for (const field of ["headSha", "baseSha", "appLogin", "reviewId"] as const) {
    test(`trusted receipt must match ${field}`, () => {
      const opts = options(); (opts.bindings[0] as any)[field] = field === "reviewId" ? 2 : OTHER;
      expect(reasons(candidate(), opts)).toContain("review_base_unbound");
    });
  }
  for (const state of ["DISMISSED", "CHANGES_REQUESTED", "COMMENTED"]) {
    test(`newer current-head ${state} blocks older APPROVED`, () => {
      const value = candidate();
      value.reviews.items.push({ ...value.reviews.items[0]!, id: 2, state, submittedAt: 20 });
      expect(reasons(value)).toContain("latest_review_not_approved");
    });
  }
  test("review order uses timestamp and id, not array order", () => {
    const value = candidate();
    value.reviews.items.unshift({ ...value.reviews.items[0]!, id: 2, state: "CHANGES_REQUESTED", submittedAt: 20 });
    expect(reasons(value)).toContain("latest_review_not_approved");
  });
  test("later submittedAt wins despite a lower review id", () => {
    const value = candidate(); value.reviews.items[0]!.id = 30;
    value.reviews.items.push({ ...value.reviews.items[0]!, id: 2, state: "PENDING", submittedAt: 20 });
    expect(reasons(value)).toContain("latest_review_not_approved");
  });
  test("equal submittedAt uses the higher id as a deterministic tie-break", () => {
    const value = candidate();
    value.reviews.items.push({ ...value.reviews.items[0]!, id: 2, state: "PENDING" });
    expect(reasons(value)).toContain("latest_review_not_approved");
  });
});

describe("RE-6 remaining eligibility conditions", () => {
  const cases: [string, (v: Candidate) => void, string][] = [
    ["unresolved thread", v => v.threads.items.push({ resolved: false }), "unresolved_thread"],
    ["missing CI", v => v.ci.results = [], "ci_not_green"],
    ["failed CI", v => v.ci.results = ["FAILURE"], "ci_not_green"],
    ["pending CI", v => v.ci.results = ["PENDING"], "ci_not_green"],
    ["wrong CI head", v => v.ci.headSha = OTHER, "ci_not_green"],
    ["unknown CI", v => v.ci.configured = null, "ci_configuration_unproven"],
    ["unapproved enhancement", v => v.issue.approved = false, "intent_unapproved"],
    ["unknown issue type", v => v.issue.type = "other", "intent_unverified"],
    ["unknown loop state", v => v.loop.complete = false, "loop_state_unproven"],
    ["fourth round", v => v.loop.rounds = 4, "round_limit"],
    ["invalid rounds", v => v.loop.rounds = -1, "loop_state_unproven"],
    ["active cooldown", v => v.loop.lastAttemptAt = NOW - 1, "cooldown"],
  ];
  for (const [name, mutate, reason] of cases) {
    test(name, () => {
      const value = candidate(); mutate(value);
      expect(reasons(value)).toContain(reason);
    });
  }
  test("no linked issue is not an implicit bug exemption", () => {
    expect(reasons({ ...candidate(), issue: null })).toContain("intent_unverified");
  });
  test("typed bug exemption waives only the intent label", () => {
    const value = candidate(); value.issue.type = "bug"; value.issue.approved = false;
    expect(reasons(value)).toEqual(["atomic_base_guard_unproven"]);
    value.ci.results = ["FAILURE"];
    expect(reasons(value)).toContain("ci_not_green");
  });
  test("proven absence of CI waives only check results", () => {
    const value = candidate(); value.ci.configured = false; value.ci.results = [];
    expect(reasons(value)).toEqual(["atomic_base_guard_unproven"]);
    value.threads.items.push({ resolved: false });
    expect(reasons(value)).toContain("unresolved_thread");
  });
  test("cooldown is a minimum elapsed duration: equality and one ms after allow, one ms before refuses", () => {
    const value = candidate();
    value.loop.lastAttemptAt = NOW - options().cooldownMs;
    expect(reasons(value)).toEqual(["atomic_base_guard_unproven"]);
    value.loop.lastAttemptAt -= 1;
    expect(reasons(value)).toEqual(["atomic_base_guard_unproven"]);
    value.loop.lastAttemptAt += 2;
    expect(reasons(value)).toContain("cooldown");
  });
});

test("RE-7 concurrent read-only audits cannot claim or merge", async () => {
  const input = candidate();
  const original = structuredClone(input);
  const overlapping = { ...structuredClone(input), number: 2 };
  const results = await Promise.all([input, input, overlapping].map(async value => auditReviewEligibility(value, options())));
  expect(results.every(result => result.automaticMerge === false)).toBe(true);
  expect(results[0]!.reasons).toEqual(results[1]!.reasons);
  expect(input).toEqual(original);
});
