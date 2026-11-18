/**
 * Per-work root for the castle work loop (anima #135):
 *
 *   <root>/tree   the working tree the author edits
 *   <root>/git    its own Git directory (a separate-git-dir clone), so Git metadata that
 *                 tools can write lives under the work root and never inside a developer
 *                 checkout's shared Git directory
 *   <root>/tmp    temp space
 *   <root>/home   HOME for the session's tools
 *
 * Existing work is retained: a second call reuses the tree and never resets it.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { sandboxCommand } from "./sandbox";
import { spawnSession } from "./supervisor";
import { executableGitConfig } from "./git-config";

export interface WorkspaceInput {
  /** Absolute path of the work root. */
  root: string;
  /** What to clone: a URL or a local repository path. */
  source: string;
  /** Work branch, `work/<issue>-<workId>`. */
  branch: string;
  /** Base branch to refresh before creating a new workspace. */
  base?: string;
  /** Stop preparing when the session loses its lease or expires. */
  signal?: AbortSignal;
  /** Directories Git on the author's tree may not read (credentials); the same list the session's tools get. */
  denyReadRoots?: string[];
}

export interface Workspace {
  root: string;
  tree: string;
  gitDir: string;
  tmp: string;
  home: string;
  branch: string;
  /** True when this call made the tree, false when it found one. */
  created: boolean;
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

const FULL_SHA = /^[0-9a-f]{40}$/;
/** Options that stop a repository's own configuration from naming a program for Git to run. */
const NEUTRAL = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];

function hostEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "https:ssh:file",
  };
}

type GitResult = { ok: boolean; out: string; err: string };

/** Cancellation must distinguish a proved stop from a process that might still be writing. */
export class WorkspacePreparationStopped extends Error {
  constructor(
    what: string,
    readonly cessation: "proven" | "unproven",
    readonly aborted: boolean,
  ) {
    super(`git ${what} stopped or timed out`);
    this.name = "WorkspacePreparationStopped";
  }
}

function run(argv: string[], cwd: string, home: string): GitResult {
  const r = Bun.spawnSync(argv, { cwd, env: hostEnv(home) });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

/** Git on a directory the host owns (a fresh clone before the author has touched it, a staging repository). */
function git(cwd: string, home: string, args: string[]): GitResult {
  return run(["git", ...NEUTRAL, ...args], cwd, home);
}

/**
 * Git on the author's tree. The author can write that tree's Git directory (hooks, `core.fsmonitor`, clean
 * filters, aliases of every kind), so the host never runs it bare: the command runs under the same write
 * boundary as the author's own tools, with no network and no credentials, and with the options that name a
 * program switched off.
 */
function treeGit(root: string, home: string, args: string[], denyReadRoots: string[] = []): GitResult {
  // Git status can execute a configured clean filter, even with hooks/fsmonitor disabled.
  // Inspect configuration first; a sandboxed helper can still outlive the Git process.
  if (args.includes("status")) {
    const preflight = sandboxCommand({ writableRoots: [root], denyReadRoots }, ["git", ...NEUTRAL, "config", "--null", "--list"]);
    const config = run(preflight, join(root, "tree"), home);
    if (!config.ok) return { ok: false, out: "", err: "cannot inspect Git configuration" };
    if (executableGitConfig(config.out) === "filter") {
      return { ok: false, out: "", err: "external Git filter configured; status refused" };
    }
  }
  const argv = sandboxCommand({ writableRoots: [root], denyReadRoots }, ["git", ...NEUTRAL, ...args]);
  return run(argv, join(root, "tree"), home);
}

/**
 * Read-only git on the author's tree for the host (the publish fallback): the same sandboxed `treeGit` that
 * `isDirty` uses, home inside the work root, no global config. Throws on a non-zero exit.
 */
export function readTreeGit(tree: string, args: string[], options: { denyReadRoots?: string[] } = {}): string {
  const root = dirname(tree);
  const r = treeGit(root, join(root, "home"), args, options.denyReadRoots ?? []);
  if (!r.ok) throw new Error(`git ${args[0] ?? ""} failed: ${(r.err || r.out).slice(0, 200)}`);
  return r.out;
}

/**
 * Recovery must inspect the exact tree and separate Git directory created for this work, even if the
 * repository's writable config or .git file has been redirected. All Git calls remain sandboxed.
 */
export function readRecoveryTreeGit(tree: string, args: string[], options: { denyReadRoots?: string[] } = {}): string {
  const root = dirname(tree);
  const canonicalRoot = realpathSync(root);
  const expectedTree = join(canonicalRoot, "tree");
  const expectedGit = join(canonicalRoot, "git");
  for (const [path, expected] of [[tree, expectedTree], [join(root, "git"), expectedGit]]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== expected) {
      throw new Error("recovery refused: workspace tree or Git directory was redirected");
    }
  }
  const marker = lstatSync(join(tree, ".git"));
  if (!marker.isFile() || marker.isSymbolicLink()) throw new Error("recovery refused: invalid workspace Git marker");
  const deny = options.denyReadRoots ?? [];
  const home = join(root, "home");
  const actualGit = must(treeGit(root, home, ["rev-parse", "--absolute-git-dir"], deny), "rev-parse");
  const actualTree = must(treeGit(root, home, ["rev-parse", "--show-toplevel"], deny), "rev-parse");
  if (realpathSync(actualGit) !== expectedGit || realpathSync(actualTree) !== expectedTree) {
    throw new Error("recovery refused: Git points to another tree or Git directory");
  }
  const r = treeGit(root, home, ["--no-replace-objects", "-c", "core.commitGraph=false", `--git-dir=${expectedGit}`, `--work-tree=${expectedTree}`, ...args], deny);
  if (!r.ok) throw new Error(`git ${args[0] ?? ""} failed: ${(r.err || r.out).slice(0, 200)}`);
  return r.out;
}

function must(r: GitResult, what: string): string {
  if (!r.ok) throw new Error(`git ${what} failed: ${r.err || r.out}`);
  return r.out;
}

/** Run host Git without blocking the heartbeat. Never include remote URLs in errors. */
async function gitAsync(
  root: string, cwd: string, home: string, args: string[], what: string, timeoutMs: number, signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new WorkspacePreparationStopped(what, "proven", true);
  const child = spawnSession({
    argv: ["git", ...NEUTRAL, ...args], cwd, root,
    env: {
      ...hostEnv(home),
      ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
      ...(process.env.GIT_SSH_COMMAND ? { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND } : {}),
    },
  });
  let stopPromise: Promise<boolean> | undefined;
  let notifyStopped!: (proven: boolean) => void;
  const stopped = new Promise<{ stopped: true; proven: boolean }>(resolve => {
    notifyStopped = proven => resolve({ stopped: true, proven });
  });
  const stop = () => {
    if (!stopPromise) {
      stopPromise = child.stopAndProve().then(result => result.proven, () => false);
      void stopPromise.then(notifyStopped);
    }
  };
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  if (signal?.aborted) stop();
  try {
    const result = await Promise.race([
      child.exited.then(exit => ({ stopped: false as const, exit })),
      stopped,
    ]);
    if (signal?.aborted) stop();
    if (stopPromise) {
      await stopPromise;
      // The supervisor checks the process group and cwd under root, but a helper
      // can detach and chdir elsewhere. A started host Git is not contained well
      // enough here to prove that every descendant is gone.
      throw new WorkspacePreparationStopped(what, "unproven", Boolean(signal?.aborted));
    }
    if (!result.stopped && result.exit.code !== 0) throw new Error(`git ${what} failed`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

function validBranch(branch: string): boolean {
  return BRANCH.test(branch) && !branch.includes("..") && !branch.endsWith("/") && !branch.endsWith(".lock");
}

/**
 * Resolve the tracking remote without changing the source. A local-only repository without
 * an explicitly configured base retains the legacy offline clone behavior.
 */
function sourceUpstream(source: string, home: string, requestedBase?: string): { base: string; url: string } | undefined {
  source = realpathSync(source);
  const remotes = must(git(source, home, ["remote"]), "remote").split("\n").filter(Boolean);
  if (!requestedBase && remotes.length === 0) return undefined;
  const base = requestedBase ?? must(git(source, home, ["symbolic-ref", "--short", "HEAD"]), "source branch");
  if (!validBranch(base)) throw new RangeError("invalid source base branch");
  let remote = git(source, home, ["config", "--get", `branch.${base}.remote`]);
  const merge = git(source, home, ["config", "--get", `branch.${base}.merge`]);
  const bare = git(source, home, ["rev-parse", "--is-bare-repository"]);
  if (!remote.ok && !merge.ok && bare.ok && bare.out === "true" && remotes.includes("origin")) {
    remote = { ok: true, out: "origin", err: "" };
  } else if (!remote.ok || !merge.ok || remote.out === "." || merge.out !== `refs/heads/${base}`) {
    throw new Error("source base has no matching upstream tracking branch");
  }
  const url = git(source, home, ["remote", "get-url", remote.out]);
  if (!url.ok || !url.out) throw new Error("source upstream has no remote URL");
  // Git interprets a relative local remote against the source repository, not our temporary copy.
  const absolute = isAbsolute(url.out) || /^[a-z][a-z0-9+.-]*:\/\//i.test(url.out) || /^[^/]+:/.test(url.out)
    ? url.out : resolve(source, url.out);
  return { base, url: absolute };
}

function checkRoot(root: string): void {
  if (!isAbsolute(root) || normalize(root) !== root.replace(/\/+$/, "") || root.split(sep).includes("..")) {
    throw new RangeError(`work root must be a normalised absolute path, got ${root}`);
  }
}

function assertGitDirUnderRoot(root: string, home: string, deny: string[]): void {
  const abs = must(treeGit(root, home, ["rev-parse", "--absolute-git-dir"], deny), "rev-parse");
  const base = realpathSync(root) + sep;
  if (!(realpathSync(abs) + sep).startsWith(base)) {
    throw new Error(`git directory ${abs} is outside the work root ${root}`);
  }
}

export async function prepareWorkspace(input: WorkspaceInput): Promise<Workspace> {
  checkRoot(input.root);
  if (!validBranch(input.branch)) throw new RangeError(`invalid work branch ${JSON.stringify(input.branch)}`);
  if (input.base && !validBranch(input.base)) throw new RangeError("invalid source base branch");
  if (input.signal?.aborted) throw new WorkspacePreparationStopped("preparation", "proven", true);
  mkdirSync(input.root, { recursive: true, mode: 0o700 });
  const marker = join(input.root, ".anima-work-preparing");
  try {
    writeFileSync(marker, "Workspace preparation in progress; recovery required if retained.\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("workspace preparation is unproven or incomplete; recovery required");
    }
    throw error;
  }

  // Record this before preparing: an existing tree is retained on errors, whereas
  // a newly created partial tree must be cleaned before the marker is released.
  const existingTree = existsSync(join(input.root, "tree", ".git"));
  let release = false;
  try {
    if (readdirSync(input.root).some(name => name.startsWith(".anima-work-source-"))) {
      throw new Error("workspace preparation has retained source artifacts; recovery required");
    }
    const ws = await prepareWorkspaceOnce(input);
    release = true;
    return ws;
  } catch (error) {
    if (!(error instanceof WorkspacePreparationStopped && error.cessation === "unproven")) {
      // Reused trees are deliberately retained. For a new tree, release only when
      // cleanup removed it; retained source artifacts always require recovery.
      try {
        release = (existingTree || (!existsSync(join(input.root, "tree")) && !existsSync(join(input.root, "git"))))
          && !readdirSync(input.root).some(name => name.startsWith(".anima-work-source-"));
      } catch { /* do not infer cleanup from an unreadable root */ }
    }
    throw error;
  } finally {
    if (release) rmSync(marker, { force: true });
  }
}

async function prepareWorkspaceOnce(input: WorkspaceInput): Promise<Workspace> {
  const { root, source, branch } = input;
  const deny = input.denyReadRoots ?? [];
  checkRoot(root);
  if (!validBranch(branch)) {
    throw new RangeError(`invalid work branch ${JSON.stringify(branch)}`);
  }
  if (input.base && !validBranch(input.base)) throw new RangeError("invalid source base branch");
  if (input.signal?.aborted) throw new WorkspacePreparationStopped("preparation", "proven", true);

  const ws: Workspace = {
    root, tree: join(root, "tree"), gitDir: join(root, "git"), tmp: join(root, "tmp"), home: join(root, "home"), branch, created: false,
  };
  for (const dir of [ws.root, ws.tmp, ws.home]) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const checkout = () => {
    // A checkout can execute worktree-controlled filters, which can outlive Git
    // even inside the sandbox. Do not start one we cannot prove has stopped.
    const config = treeGit(ws.root, ws.home, ["config", "--null", "--list"], deny);
    if (!config.ok) throw new Error("cannot inspect workspace Git configuration safely");
    const hasExternalFilter = config.out.split("\0").some((entry) => {
      const key = entry.split("\n", 1)[0] ?? "";
      return /^filter\..+\.(?:clean|smudge|process)$/i.test(key);
    });
    if (hasExternalFilter) throw new Error("automatic checkout refused: external Git filter is configured");
    const exists = treeGit(ws.root, ws.home, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], deny).ok;
    must(treeGit(ws.root, ws.home, exists ? ["checkout", "-q", branch] : ["checkout", "-q", "-b", branch], deny), "checkout");
  };

  if (!existsSync(join(ws.tree, ".git"))) {
    // A half-made earlier attempt has no usable tree: clear only what this function makes under the root.
    if (existsSync(ws.tree)) rmSync(ws.tree, { recursive: true, force: true });
    if (existsSync(ws.gitDir)) rmSync(ws.gitDir, { recursive: true, force: true });
    let mirrorRoot: string | undefined;
    let preserve = false;
    try {
      let cloneSource = source;
      let base = input.base;
      if (existsSync(source)) {
        const upstream = sourceUpstream(source, ws.home, base);
        if (upstream) {
          base = upstream.base;
          // Keeping the copy under the work root lets the supervisor find processes
          // that escape Git's process group while still using the temporary repository.
          mirrorRoot = mkdtempSync(join(ws.root, ".anima-work-source-"));
          const mirror = join(mirrorRoot, "source.git");
          await gitAsync(ws.root, ws.root, ws.home, ["clone", "-q", "--bare", "--no-hardlinks", "--", source, mirror], "source copy", 1_800_000, input.signal);
          await gitAsync(ws.root, mirror, ws.home, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", "--",
            upstream.url, `+refs/heads/${base}:refs/anima/upstream`], "upstream fetch", 60_000, input.signal);
          const local = must(git(mirror, ws.home, ["rev-parse", "--verify", `refs/heads/${base}^{commit}`]), "source base");
          const latest = must(git(mirror, ws.home, ["rev-parse", "--verify", "refs/anima/upstream^{commit}"]), "upstream base");
          if (!git(mirror, ws.home, ["merge-base", "--is-ancestor", local, latest]).ok) {
            throw new Error("source base cannot fast-forward to upstream (ahead or divergent)");
          }
          must(git(mirror, ws.home, ["update-ref", `refs/heads/${base}`, latest, local]), "update temporary base");
          must(git(mirror, ws.home, ["symbolic-ref", "HEAD", `refs/heads/${base}`]), "select temporary base");
          cloneSource = mirror;
        }
      }
      const branchArgs = base ? ["--branch", base] : [];
      await gitAsync(ws.root, ws.root, ws.home, ["clone", "-q", "--no-hardlinks", ...branchArgs,
        "--separate-git-dir", ws.gitDir, "--", cloneSource, ws.tree], "clone", 1_800_000, input.signal);
      if (mirrorRoot) {
        must(git(ws.tree, ws.home, ["remote", "set-url", "origin", source]), "restore clone origin");
        // Later explicit fetches from the stale local source must not rewind the fresh snapshot.
        must(git(ws.tree, ws.home, ["config", "--replace-all", "remote.origin.fetch",
          "+refs/heads/*:refs/remotes/source/*"]), "separate source fetch refs");
      }
      // If an abort races the completed clone, do not infer cessation from the signal.
      if (input.signal?.aborted) throw new WorkspacePreparationStopped("preparation", "unproven", true);
      assertGitDirUnderRoot(ws.root, ws.home, deny);
      // The commit this work starts from, written by the host before the author has touched the tree. The host publish
      // (rfcclub/anima#305) takes its base from here, never from a ref inside the author's tree. The file is a sibling of
      // the work root, outside everything the author's session can write.
      writeFileSync(`${ws.root}.base-sha`, `${must(git(ws.tree, ws.home, ["rev-parse", "--verify", "HEAD^{commit}"]), "base commit")}\n`);
      checkout();
    } catch (error) {
      preserve = error instanceof WorkspacePreparationStopped && error.cessation === "unproven";
      if (!preserve) {
        if (existsSync(ws.tree)) rmSync(ws.tree, { recursive: true, force: true });
        if (existsSync(ws.gitDir)) rmSync(ws.gitDir, { recursive: true, force: true });
      }
      throw error;
    } finally {
      if (mirrorRoot && !preserve) rmSync(mirrorRoot, { recursive: true, force: true });
    }
    ws.created = true;
    return ws;
  }

  assertGitDirUnderRoot(ws.root, ws.home, deny);
  if (!treeGit(ws.root, ws.home, ["rev-parse", "--verify", "HEAD^{commit}"], deny).ok) {
    throw new Error("incomplete workspace has no committed HEAD; recovery required");
  }
  const current = must(treeGit(ws.root, ws.home, ["rev-parse", "--abbrev-ref", "HEAD"], deny), "rev-parse");
  if (current !== branch) checkout();
  return ws;
}

/**
 * True when the tree holds work that is not yet anywhere else: uncommitted or untracked changes,
 * or commits no remote-tracking ref has. Such a work root is never cleaned up automatically.
 */
export function isDirty(tree: string, options: { denyReadRoots?: string[] } = {}): boolean {
  const root = dirname(tree);
  const home = join(root, "home");
  const deny = options.denyReadRoots ?? [];
  const status = treeGit(root, home, ["status", "--porcelain", "--untracked-files=all"], deny);
  if (!status.ok || status.out !== "") return true;
  const ahead = treeGit(root, home, ["rev-list", "--count", "HEAD", "--not", "--remotes"], deny);
  return !ahead.ok || Number(ahead.out) > 0;
}

/**
 * A repository the host owns, outside the work root, that holds the work branch and nothing of the author's
 * configuration: no hooks, no config, no URL rewrites. The host pushes from here, never from the author's own
 * Git directory. The branch is brought over by a fetch that runs under the write boundary (it may write only
 * the staging repository, it has no network and no credentials), so nothing the author planted in the source
 * repository's configuration can run with the host's authority. Objects are verified on the way in.
 */
export function stageBranchForPush(work: { root: string; branch: string }, options: { denyReadRoots?: string[] } = {}): string {
  checkRoot(work.root);
  const bare = `${work.root}.push.git`;
  const home = join(work.root, "home");
  if (!existsSync(bare)) must(git(dirname(work.root), home, ["init", "--bare", "-q", "--template=", bare]), "init");
  const argv = sandboxCommand({ writableRoots: [bare], denyReadRoots: options.denyReadRoots }, [
    "git", ...NEUTRAL, "-c", "protocol.file.allow=always", "-c", "transfer.fsckObjects=true",
    "fetch", "-q", "--no-tags", "--no-write-fetch-head", join(work.root, "git"), `+refs/heads/${work.branch}:refs/heads/${work.branch}`,
  ]);
  must(run(argv, bare, home), "fetch into the staging repository");
  must(git(bare, home, ["symbolic-ref", "HEAD", `refs/heads/${work.branch}`]), "symbolic-ref");
  must(git(bare, home, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]), "rev-parse");
  return bare;
}

/** The commit the staged branch points at. */
export function stagedCommit(stagingDir: string): string {
  return must(git(stagingDir, stagingDir, ["rev-parse", "HEAD"]), "rev-parse");
}

/**
 * Notes in the author's tree that `sha` is on the remote, so a published, clean tree stops counting as unmerged
 * work. The push goes to an explicit URL, which updates no remote-tracking ref by itself.
 */
export function recordPushed(work: { root: string; branch: string }, sha: string, options: { denyReadRoots?: string[] } = {}): void {
  checkRoot(work.root);
  if (!FULL_SHA.test(sha)) throw new RangeError(`not a commit id: ${sha}`);
  const home = join(work.root, "home");
  const deny = options.denyReadRoots ?? [];
  must(treeGit(work.root, home, ["cat-file", "-e", `${sha}^{commit}`], deny), "cat-file");
  must(treeGit(work.root, home, ["update-ref", `refs/remotes/origin/${work.branch}`, sha], deny), "update-ref");
}
