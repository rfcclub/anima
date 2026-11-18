import type { IsolatedGit } from "./publish-snapshot";

export interface HostCommitInput {
  /** The host's isolated Git invocation (isolatedGit(...)), the same one that produced treeHash. */
  iso: IsolatedGit;
  /** The tree to commit: the treeHash the judge returned. */
  treeHash: string;
  /** The base commit the work branched from. */
  base: string;
  issue: number;
  workId: string;
}

export const HOST_COMMITTER_NAME = "ANIMA host publish";
export const HOST_COMMITTER_EMAIL = "host-publish@anima.invalid";

const WORK_ID = /^w[0-9a-f]{6,16}$/;
const HASH = /^[0-9a-f]{40}$/;

function invalid(): never {
  throw new Error("Invalid commit input");
}

/** Message of the host commit: names the host and the work (spec). */
export function hostCommitMessage(issue: number, workId: string): string {
  if (!Number.isSafeInteger(issue) || issue < 1) invalid();
  if (typeof workId !== "string" || !WORK_ID.test(workId)) invalid();
  return `Host-published work for #${issue} (${workId})`;
}

/** Create the commit object in the host's Git directory and return its 40-hex sha. No ref is written. */
export function createHostCommit(
  run: (iso: IsolatedGit, args: string[]) => string,
  input: HostCommitInput,
): string {
  const message = hostCommitMessage(input.issue, input.workId);
  if (typeof input.treeHash !== "string" || !HASH.test(input.treeHash)) invalid();
  if (typeof input.base !== "string" || !HASH.test(input.base)) invalid();

  const sha = run(input.iso, [
    "-c", "user.name=" + HOST_COMMITTER_NAME,
    "-c", "user.email=" + HOST_COMMITTER_EMAIL,
    "commit-tree", input.treeHash, "-p", input.base, "-m", message,
  ]).trim();
  if (!HASH.test(sha)) throw new Error("Invalid commit hash");
  return sha;
}
