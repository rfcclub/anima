/**
 * The host publish stage (rfcclub/anima#305, slice E2): bring the base object into the host-owned staging
 * repository and, once the host commit exists, point a branch at it.
 *
 * The staging repository `<work.root>.push.git` is filled today by fetching the author's `refs/heads/<branch>`.
 * A tree the model never committed has no such branch, so the host fetches the base by sha into `refs/host/base`
 * (the object snapshotChange reads the base tree from) and records the host commit as the branch it pushes.
 */

/** Run git with exactly these arguments (no shell) and return stdout; throws on a non-zero exit. */
export type GitRun = (args: string[]) => string;

const COMMIT = /^[0-9a-f]{40}$/;
const WORK_BRANCH = /^work\/[0-9]+-w[0-9a-f]{6,16}$/;

function absolute(path: string): boolean {
  return path.startsWith("/") && !/[\0\r\n]/.test(path);
}

function validate(ok: boolean): void {
  if (!ok) throw new Error("Invalid stage input");
}

/** Fetch `base` from the author's Git directory into `refs/host/base` of the staging repository. */
export function fetchBase(run: GitRun, input: { bare: string; authorGitDir: string; base: string }): void {
  validate(absolute(input.bare) && absolute(input.authorGitDir) && COMMIT.test(input.base));
  run([
    "--git-dir", input.bare,
    "-c", "protocol.file.allow=always",
    "-c", "transfer.fsckObjects=true",
    "fetch", "-q", "--no-tags", "--no-write-fetch-head",
    input.authorGitDir, `+${input.base}:refs/host/base`,
  ]);
  const out = run(["--git-dir", input.bare, "rev-parse", "--verify", "-q", "refs/host/base^{commit}"]);
  if (out.trim() !== input.base) throw new Error("Base not staged");
}

/** Point `refs/heads/<branch>` and HEAD of the staging repository at the host commit. */
export function recordHostBranch(run: GitRun, input: { bare: string; branch: string; sha: string }): void {
  validate(absolute(input.bare) && WORK_BRANCH.test(input.branch) && COMMIT.test(input.sha));
  run(["--git-dir", input.bare, "update-ref", `refs/heads/${input.branch}`, input.sha]);
  run(["--git-dir", input.bare, "symbolic-ref", "HEAD", `refs/heads/${input.branch}`]);
  const out = run(["--git-dir", input.bare, "rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  if (out.trim() !== input.sha) throw new Error("Branch not staged");
}
