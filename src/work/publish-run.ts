import type { JudgeOutcome } from "./publish-judge";
import { hostPrBody, hostPrTitle } from "./publish-pr-text";
import type { HostPrTextInput } from "./publish-pr-text";

export interface HostRunDeps {
  /** publish-stage.fetchBase bound to the staging repository and the base sha. */
  fetchBase: () => void;
  /** judgeWorkTree bound to the host's snapshot, reader, test command and test runner. */
  judge: () => Promise<JudgeOutcome>;
  /** publish-commit.createHostCommit bound to the judged tree; returns the commit sha. */
  commit: (treeHash: string) => string;
  /** publish-stage.recordHostBranch bound to the staging repository and the work branch. */
  recordBranch: (sha: string) => void;
  /** Publisher.pushHostStaged bound to the work; returns the tool output (JSON text). */
  push: () => Promise<string>;
  /** Publisher.openDraftPr bound to the work; returns the tool output (JSON text). */
  openDraftPr: (title: string, body: string) => Promise<string>;
  /** The lease/generation guard. A throw means this writer lost the work: it is NOT caught here. */
  guard: () => Promise<void>;
  issueTitle: string;
  /** Everything of HostPrTextInput except what the judge outcome supplies. */
  text: Omit<HostPrTextInput, "issueTitle" | "testOutput" | "fileCount" | "addedLines" | "deletedLines" | "generatedCount">;
}

export type HostRunResult =
  | { published: true; sha: string; prOutput: string; checks: string[] }
  | { published: false; reason: string; pushed: boolean; /** The host commit that is on the remote when `pushed` is true, for an operator who opens the pull request by hand. */ sha?: string };

/** The checks the judge runs, in the order it runs them (the spec's five checks, the tests and the second snapshot). */
const CHECKS = ["no-change", "outside-repo", "denied-path", "too-large", "secret-found", "tests", "tree-unchanged"];

/** A tool output is ok only when it is JSON with `status: "ok"`; an error string is never parsed. */
function isOk(output: string): boolean {
  try {
    const parsed: unknown = JSON.parse(output);
    return typeof parsed === "object" && parsed !== null && (parsed as { status?: unknown }).status === "ok";
  } catch {
    return false;
  }
}

const failed = (pushed: boolean, sha?: string): HostRunResult =>
  ({ published: false, reason: "error", pushed, ...(pushed && sha ? { sha } : {}) });
/**
 * The pull request call returned something that is not ok after a good push (SC-027). An exception, or a failure to
 * build the text, is the generic `error` result with `pushed: true`: the consumer maps `pushed: true` to the same
 * recorded state (branch on the remote, no pull request).
 */
const prFailed = (sha: string): HostRunResult => ({ published: false, reason: "pr-create-failed (branch pushed)", pushed: true, sha });

/**
 * Run the host publish: guard, fetch, judge, commit, record, push and open the draft pull request, in that order,
 * stopping at the first failure. Every effect is injected; a guard throw is a lost lease and propagates (#305, E4b).
 */
export async function runHostPublish(deps: HostRunDeps): Promise<HostRunResult> {
  await deps.guard();

  try {
    deps.fetchBase();
  } catch {
    return failed(false);
  }

  let outcome: JudgeOutcome;
  try {
    outcome = await deps.judge();
  } catch {
    return failed(false);
  }
  if (!outcome.ok) return { published: false, reason: outcome.check, pushed: false };

  await deps.guard();

  let sha: string;
  try {
    sha = deps.commit(outcome.treeHash);
    deps.recordBranch(sha);
  } catch {
    return failed(false);
  }

  await deps.guard();

  let pushedOutput: string;
  try {
    pushedOutput = await deps.push();
  } catch {
    await deps.guard();
    return failed(false);
  }
  if (!isOk(pushedOutput)) {
    // The publisher turns a lost lease into an error string, so the writer asks again: a lost lease propagates (SC-023).
    await deps.guard();
    return failed(false);
  }

  let title: string;
  let body: string;
  try {
    title = hostPrTitle(deps.issueTitle);
    body = hostPrBody({
      ...deps.text,
      issueTitle: deps.issueTitle,
      testOutput: outcome.testOutput,
      fileCount: outcome.files.length,
      addedLines: outcome.files.reduce((sum, file) => sum + file.added, 0),
      deletedLines: outcome.files.reduce((sum, file) => sum + file.deleted, 0),
      generatedCount: outcome.generated.length,
    });
  } catch {
    return failed(true, sha);
  }

  await deps.guard();

  let prOutput: string;
  try {
    prOutput = await deps.openDraftPr(title, body);
  } catch {
    await deps.guard();
    return failed(true, sha);
  }
  if (!isOk(prOutput)) {
    await deps.guard();
    return prFailed(sha);
  }

  return { published: true, sha, prOutput, checks: [...CHECKS] };
}
