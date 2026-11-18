/**
 * The real bindings of the host publish run (rfcclub/anima#305, slice E5a).
 *
 * `runHostPublish` (publish-run.ts) takes every effect as a function. This module builds those functions for one
 * work: the host-owned staging repository `<work.root>.push.git` is the only Git directory the host reads or writes
 * with its own configuration; the work tree's `.git` is never asked to run anything. Git runs with the snapshot's
 * isolated invocation (host Git directory, `--work-tree`, empty hooks, no fsmonitor, no global or system config).
 */

import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { createHostCommit } from "./publish-commit";
import { isGeneratedPath } from "./publish-checks";
import { judgeWorkTree } from "./publish-judge";
import { runHostPublish, type HostRunResult } from "./publish-run";
import { fetchBase, recordHostBranch, type GitRun } from "./publish-stage";
import { GENERATED_EXCLUDES, isolatedGit, snapshotChange, type IsolatedGit } from "./publish-snapshot";
import { deriveTestCommand, type TestOutcome } from "./publish-tests";
import type { Publisher } from "./publish";
import { sandboxCommand } from "./sandbox";
import type { WorkRecord } from "./store";

const MAX_READ_BYTES = 2_000_000;

export interface HostPublishDeps {
  /** Runs `git <args>` in `cwd` with exactly `env` and returns stdout; throws on a non-zero exit. Defaults to `spawnGitSync`. */
  spawnGit?: (args: string[], options: { cwd: string; env: Record<string, string> }) => string;
  /** The derived test command, run with a timeout in the work tree under the sandbox profile (the caller binds spawnRun). */
  runTests: (argv: string[], cwd: string) => Promise<TestOutcome>;
  /** The host-only publisher methods (the model cannot reach either). */
  publisher: Pick<Publisher, "pushHostStaged" | "openDraftPr">;
  /** The commit the work branched from, read from the author's Git directory. */
  baseSha: (work: WorkRecord) => string;
}

export interface HostPublishInput {
  work: WorkRecord;
  stopCause: "deadline" | "max_reached";
  issue: { title: string; body: string };
  /** Throws when this writer lost the lease or the generation. A throw propagates; the guard must stay failed once it has failed. */
  guard: () => Promise<void>;
}

function spawnArgv(argv: string[], args: string[], options: { cwd: string; env: Record<string, string> }): string {
  const child = Bun.spawnSync(argv, { cwd: options.cwd, env: options.env, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`git ${args.find((arg) => !arg.startsWith("-") && !arg.includes("=") && !arg.includes("/")) ?? ""} failed (${child.exitCode})`);
  return child.stdout.toString();
}

/** `git <args>` without a shell. Failures throw a generic error: Git's stderr can echo paths and file content. */
export function spawnGitSync(args: string[], options: { cwd: string; env: Record<string, string> }): string {
  return spawnArgv(["git", ...args], args, options);
}

/** The Git subcommand of an argument list: the first argument after the global options (`--git-dir <p>`, `-c <k=v>`, `-C <p>`, flags). */
export function gitSubcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--git-dir" || arg === "-c" || arg === "-C") { i++; continue; }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

/**
 * The one command that reads the author's Git directory is the fetch of the base into the staging repository. It runs
 * under the same write sandbox as `stageBranchForPush` (writes only into the staging repository, credentials unreadable);
 * every other Git command goes to `inner`. The staging repository is the `--git-dir` of the command.
 */
export function sandboxedFetchSpawn(options: {
  denyReadRoots: string[];
  inner?: (args: string[], options: { cwd: string; env: Record<string, string> }) => string;
}): (args: string[], spawnOptions: { cwd: string; env: Record<string, string> }) => string {
  const inner = options.inner ?? spawnGitSync;
  return (args, spawnOptions) => {
    const gitDir = args[0] === "--git-dir" ? args[1] : undefined;
    if (gitDir === undefined || gitSubcommand(args) !== "fetch") return inner(args, spawnOptions);
    return spawnArgv(sandboxCommand({ writableRoots: [gitDir], denyReadRoots: options.denyReadRoots }, ["git", ...args]), args, spawnOptions);
  };
}

/** A test path counts only when its real path (symlinks resolved) is a regular file inside the work tree. */
function existsInTree(tree: string, path: string): boolean {
  try {
    const realTree = realpathSync(tree);
    const real = realpathSync(join(tree, path));
    return real.startsWith(realTree + sep) && statSync(real).isFile();
  } catch {
    return false;
  }
}

export function createHostPublish(deps: HostPublishDeps): (input: HostPublishInput) => Promise<HostRunResult> {
  const spawn = deps.spawnGit ?? spawnGitSync;
  return (input) => {
    const { work } = input;
    const tree = join(work.root, "tree");
    const authorGitDir = join(work.root, "git");
    const bare = `${work.root}.push.git`;
    const emptyHooks = `${work.root}.empty-hooks`;
    const baseEnv = { PATH: process.env.PATH ?? "", LANG: process.env.LANG ?? "C" };
    const plainEnv = { ...baseEnv, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
    const plain: GitRun = (args) => spawn(args, { cwd: work.root, env: plainEnv });

    let base = "";
    let iso: IsolatedGit | undefined;
    let scannedTree = "";
    let testCommand: string[] = ["bun", "test"];
    const run = (isolated: IsolatedGit, args: string[]): string =>
      spawn([...isolated.args, ...args], { cwd: tree, env: { ...isolated.env, ...baseEnv } });

    return runHostPublish({
      guard: input.guard,
      issueTitle: input.issue.title,
      fetchBase: () => {
        if (!existsSync(bare)) plain(["init", "--bare", "-q", "--template=", bare]);
        mkdirSync(emptyHooks, { recursive: true });
        // The hooks directory must stay empty: anything in it would run as a hook. Fail closed rather than trust what is there.
        if (readdirSync(emptyHooks).length > 0) throw new Error("hooks directory is not empty");
        base = deps.baseSha(work);
        fetchBase(plain, { bare, authorGitDir, base });
        iso = isolatedGit({ gitDir: bare, indexFile: join(bare, "host-index"), tree, emptyHooksDir: emptyHooks });
      },
      judge: () => judgeWorkTree({
        // The hash and the committed tree exclude the generated files; they are listed again (from a second, unfiltered
        // snapshot that is never committed) only so the judge can count them for the pull request text.
        snapshot: () => {
          const kept = snapshotChange(run, iso!, base, { exclude: GENERATED_EXCLUDES });
          // The scan below reads this tree object, which is the one the host commit will hold. It never reads the host index
          // again: the second snapshot rewrites that index, and a work tree that changes between the two snapshots would
          // otherwise be scanned as one thing and committed as another.
          scannedTree = kept.treeHash;
          const everything = snapshotChange(run, iso!, base);
          return { treeHash: kept.treeHash, files: [...kept.files, ...everything.files.filter((file) => isGeneratedPath(file.path))] };
        },
        // The scan reads the blob that the host commit will hold, from the committed tree object (`<tree>:<path>`), not the raw
        // work-tree bytes: `.gitattributes` can re-encode a file (working-tree-encoding) on its way into Git, and a symlink's
        // blob is its target. `<tree>:<path>` splits at the first colon, so a path such as `0:a` is read as itself. A missing,
        // oversized or unreadable blob is undefined: the judge fails closed.
        readText: (path) => {
          try {
            if (!scannedTree) return undefined;
            const size = Number(run(iso!, ["cat-file", "-s", `${scannedTree}:${path}`]).trim());
            if (!Number.isSafeInteger(size) || size > MAX_READ_BYTES) return undefined;
            return run(iso!, ["cat-file", "blob", `${scannedTree}:${path}`]);
          } catch {
            return undefined;
          }
        },
        testCommand: (kept) => {
          const argv = deriveTestCommand(input.issue.body, kept.map((file) => file.path), (path) => existsInTree(tree, path));
          if (argv) testCommand = argv;
          return argv;
        },
        runTests: (argv) => deps.runTests(argv, tree),
      }),
      commit: (treeHash) => createHostCommit(run, { iso: iso!, treeHash, base, issue: work.issue, workId: work.workId }),
      recordBranch: (sha) => recordHostBranch(plain, { bare, branch: work.branch, sha }),
      push: () => deps.publisher.pushHostStaged(work, input.guard),
      openDraftPr: (title, body) => deps.publisher.openDraftPr(work, { title, body }, input.guard),
      // Read when the pull request text is built, after the judge has derived the command.
      get text() {
        return {
          issue: work.issue,
          workId: work.workId,
          stopCause: input.stopCause,
          execMsUsed: work.execMsUsed,
          workWallMs: work.caps.workWallMs,
          sessionsUsed: work.sessionsUsed,
          maxSessions: work.caps.maxSessions,
          testCommand,
        };
      },
    });
  };
}
