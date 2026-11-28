/**
 * The GitHub action allowlist is part of the session profile, not the prompt: the CLI reads the profile from
 * the flags and environment it was started with, and the tool refuses everything the profile does not name.
 */

import { describe, expect, test } from "bun:test";
import { githubActionsFor, githubActionsForSession } from "../../src/tools/github-actions";

describe("session profile GitHub action allowlists", () => {
  test("a review profile may read the pull request and post one verdict", () => {
    expect(githubActionsFor("review")).toEqual(["review", "review_threads"]);
  });

  test("an intent-review profile may record one verdict on its issue and nothing else", () => {
    expect(githubActionsFor("intent-review")).toEqual(["approve_intent", "issue_comment"]);
  });

  test("the returned list is a copy, so a caller cannot widen the profile", () => {
    githubActionsFor("review").push("push");
    expect(githubActionsFor("review")).toEqual(["review", "review_threads"]);
  });

  test("a headless review child runs under the review profile", () => {
    expect(githubActionsForSession({ headlessReview: true, env: {} })).toEqual(githubActionsFor("review"));
  });

  test("an intent-review child runs under the intent-review profile", () => {
    expect(githubActionsForSession({ headlessReview: false, env: { ANIMA_INTENT_REVIEW: "rfcclub/anima#56" } }))
      .toEqual(githubActionsFor("intent-review"));
  });

  test("a malformed intent target is not a profile: the child keeps its own tools", () => {
    expect(githubActionsForSession({ headlessReview: false, env: { ANIMA_INTENT_REVIEW: "rfcclub/anima" } })).toBeUndefined();
  });

  test("an ordinary session has no profile allowlist to apply", () => {
    expect(githubActionsForSession({ headlessReview: false, env: {} })).toBeUndefined();
  });
});
