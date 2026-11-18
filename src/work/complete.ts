/**
 * Evidence validation and the completion path for an external task worker (rfcclub/anima#238,
 * cartridge-worker-dispatch, slice 6: AC-12 and AC-17).
 *
 * Nothing a worker reports is trusted. A commit claim counts only if the host finds the commit on the work branch
 * itself, read through the sandboxed tree-git. A test claim counts only if the host reruns its own configured check
 * and it passes; the command the worker says it ran is never executed, and a matching exit code is evidence of the
 * host's rerun only. Claims the host cannot validate stay unvalidated, never passed.
 *
 * The worker's tree changes become commits only here: after a proven stop, while the lease and generation hold, the
 * host commits on the work branch as the work's author, with the tree's hooks, fsmonitor and signing switched off.
 */

import { join } from "node:path";
import type { StopRecord, WorkRecord } from "./store";
import { executableGitConfig } from "./git-config";

/** Git on the work tree; throws on a non-zero exit. Production: the sandboxed neutral tree-git. */
export type TreeGit = (tree: string, args: string[]) => string;

export type WorkerClaim =
  | { kind: "commit"; sha: string }
  /** `command` and `exitCode` are what the worker reported; neither is used to validate. */
  | { kind: "test"; check: string; command?: string; exitCode?: number };

/** A check the host configured; the only commands validation ever runs. */
export interface ConfiguredCheck { id: string; argv: string[]; timeoutMs: number }

export interface ClaimResult { claim: WorkerClaim; status: "validated" | "unvalidated"; detail: string }

export interface ClaimDeps {
  git: TreeGit;
  checks: ConfiguredCheck[];
  /** Runs a configured check inside a boundary at least as strict as the worker's, with its time limit. */
  runCheck: (check: ConfiguredCheck) => Promise<{ exitCode: number | null; timedOut: boolean }>;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;
const NEUTRAL = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

const treeOf = (work: WorkRecord) => join(work.root, "tree");

function gitOk(git: TreeGit, tree: string, args: string[]): boolean {
  try {
    git(tree, args);
    return true;
  } catch {
    return false;
  }
}

export async function validateClaims(deps: ClaimDeps, work: WorkRecord, claims: WorkerClaim[]): Promise<ClaimResult[]> {
  const results: ClaimResult[] = [];
  // A check runs at most once per validation, however many claims name it; a rerun that throws is unvalidated.
  const reruns = new Map<string, Promise<{ exitCode: number | null; timedOut: boolean } | "error">>();
  for (const claim of claims) {
    if (claim.kind === "commit") {
      if (!FULL_SHA.test(claim.sha)) {
        results.push({ claim, status: "unvalidated", detail: "not a full commit id" });
        continue;
      }
      const tree = treeOf(work);
      if (!gitOk(deps.git, tree, ["cat-file", "-e", `${claim.sha}^{commit}`])) {
        results.push({ claim, status: "unvalidated", detail: "commit not found" });
      } else if (!gitOk(deps.git, tree, ["merge-base", "--is-ancestor", claim.sha, `refs/heads/${work.branch}`])) {
        results.push({ claim, status: "unvalidated", detail: "commit is not on the work branch" });
      } else {
        results.push({ claim, status: "validated", detail: `commit on ${work.branch}` });
      }
      continue;
    }
    const check = deps.checks.find((c) => c.id === claim.check);
    if (!check) {
      results.push({ claim, status: "unvalidated", detail: "not a host-configured check" });
      continue;
    }
    let pending = reruns.get(check.id);
    if (!pending) {
      pending = deps.runCheck(check).catch(() => "error" as const);
      reruns.set(check.id, pending);
    }
    const rerun = await pending;
    if (rerun === "error") results.push({ claim, status: "unvalidated", detail: `host rerun of ${check.id} could not run` });
    else if (rerun.timedOut) results.push({ claim, status: "unvalidated", detail: `host rerun of ${check.id} timed out` });
    else if (rerun.exitCode !== 0) results.push({ claim, status: "unvalidated", detail: `host rerun of ${check.id} exited ${rerun.exitCode}` });
    else results.push({ claim, status: "validated", detail: `host rerun of ${check.id} exited 0` });
  }
  return results;
}

export interface CompletionInput {
  work: WorkRecord;
  /** The session's stop record; completion needs proven cessation. */
  stop: StopRecord | null;
  /** Throws unless the session still holds the lease and the work's current generation. */
  guard: () => void;
  author: { name: string; email: string };
  message: string;
  /** Optional host check of the exact staged tree before any commit is created. */
  validateTree?: (stagedTree: string, oldHead: string) => boolean;
}

export type CompletionResult = { ok: true; head: string; committed: boolean } | { ok: false; reason: string };

export function completeWork(deps: { git: TreeGit }, input: CompletionInput): CompletionResult {
  const { work } = input;
  try {
    input.guard();
  } catch (error) {
    return { ok: false, reason: `fenced: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!input.stop) return { ok: false, reason: "no stop record for the session" };
  if (input.stop.cessation !== "proven") return { ok: false, reason: `cessation unproven (${input.stop.cessationCheck ?? "unknown"})` };

  if (input.stop.workId !== work.workId) return { ok: false, reason: "stop record belongs to another work" };

  const tree = treeOf(work);
  const ref = `refs/heads/${work.branch}`;
  const fenced = (): CompletionResult | null => {
    try {
      input.guard();
      return null;
    } catch (error) {
      return { ok: false, reason: `fenced: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  const onBranch = () => deps.git(tree, [...NEUTRAL, "symbolic-ref", "-q", "HEAD"]).trim() === ref;
  try {
    // `status` and `add` can execute a worktree-configured filter. Refuse it before either command:
    // sandboxing the process alone does not prove that a filter's descendants have stopped.
    const config = deps.git(tree, [...NEUTRAL, "config", "--null", "--list"]);
    const executable = executableGitConfig(config);
    if (executable === "filter") {
      return { ok: false, reason: "external Git filter configured; host completion refused" };
    }
    if (executable) return { ok: false, reason: "executable Git configuration found; host completion refused" };
    if (!onBranch()) return { ok: false, reason: "HEAD is not on the work branch" };
    const old = deps.git(tree, [...NEUTRAL, "rev-parse", "--verify", `${ref}^{commit}`]).trim();
    if (old !== input.stop.head) return { ok: false, reason: `stop record head ${input.stop.head} is not the branch head ${old}` };
    if (deps.git(tree, [...NEUTRAL, "status", "--porcelain", "--untracked-files=all"]).trim() === "") return { ok: true, head: old, committed: false };

    // Re-check both HEAD and branch after staging, then bind the commit by compare-and-swap.
    deps.git(tree, [...NEUTRAL, "add", "-A"]);
    const lost = fenced();
    if (lost) return lost;
    if (!onBranch()) return { ok: false, reason: "HEAD moved off the work branch while staging" };
    if (deps.git(tree, [...NEUTRAL, "rev-parse", "--verify", `${ref}^{commit}`]).trim() !== old) return { ok: false, reason: "the work branch moved while staging" };
    const staged = deps.git(tree, [...NEUTRAL, "write-tree"]).trim();
    if (input.validateTree && !input.validateTree(staged, old)) {
      return { ok: false, reason: "staged tree failed the host publication safety check" };
    }
    const lostAfterValidation = fenced();
    if (lostAfterValidation) return lostAfterValidation;
    if (staged === deps.git(tree, [...NEUTRAL, "rev-parse", "--verify", `${old}^{tree}`]).trim()) return { ok: true, head: old, committed: false };
    const { name, email } = input.author;
    const created = deps.git(tree, [
      ...NEUTRAL, "-c", "commit.gpgsign=false",
      "-c", `user.name=${name}`, "-c", `user.email=${email}`, "-c", `author.name=${name}`, "-c", `author.email=${email}`,
      "-c", `committer.name=${name}`, "-c", `committer.email=${email}`,
      "commit-tree", staged, "-p", old, "-m", input.message,
    ]).trim();
    const lostBeforeRefUpdate = fenced();
    if (lostBeforeRefUpdate) return lostBeforeRefUpdate;
    deps.git(tree, [...NEUTRAL, "update-ref", "-m", "host completion", ref, created, old]);
    return { ok: true, head: created, committed: true };
  } catch (error) {
    return { ok: false, reason: `git failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` };
  }
}
