/**
 * The GitHub actions each headless session profile may use.
 *
 * A review session runs a model on untrusted pull-request text, so the prompt is not an authorization boundary:
 * the tool itself refuses every action the profile does not name, before a token is minted, and records the
 * refusal in its audit log.
 */

import { parseIntentTarget, INTENT_REVIEW_ENV } from "./review-budget";

export type GithubSessionProfile = "review" | "intent-review";

/** `null` is the ordinary session: the profile adds no restriction beyond `allowedTools`. */
export const GITHUB_PROFILE_ACTIONS: Record<GithubSessionProfile, readonly string[]> = {
  /** Reading the PR and posting one verdict; nothing that creates, pushes, merges or approves an intent. */
  review: ["review", "review_threads"],
  /** Recording one verdict on the issue under review, and nothing else. */
  "intent-review": ["approve_intent", "issue_comment"],
};

/** The actions a profile may use, in a stable order, for the policy and the job event. */
export function githubActionsFor(profile: GithubSessionProfile): string[] {
  return [...GITHUB_PROFILE_ACTIONS[profile]];
}

/**
 * The allowlist of the session this process was started as, read from its own flags and environment. A work
 * session and an ordinary talk session have none: they have no `anima_github` to restrict.
 */
export function githubActionsForSession(input: {
  headlessReview: boolean;
  env: Record<string, string | undefined>;
}): string[] | undefined {
  if (input.headlessReview) return githubActionsFor("review");
  // An intent-review child is told its issue by the environment; anything else is not that profile.
  if (parseIntentTarget(input.env[INTENT_REVIEW_ENV])) return githubActionsFor("intent-review");
  return undefined;
}
