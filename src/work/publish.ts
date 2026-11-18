/**
 * Publishing for a work session, over the existing GitHub App tool (anima #135, WL-10).
 *
 * The model can ask for two things: push its own work branch, and open the pull request for it. Everything
 * that names a target (repository, branch, base, directory) comes from the work record, never from the model's
 * arguments; merge, review, approval and every other action of the tool are not reachable from here. The App
 * token is minted inside the tool and never passes through the session.
 *
 * The author can write its tree's Git directory, so the push never runs from there: the branch is staged into a
 * repository the host owns (no hooks, no author configuration) and the tool pushes from that.
 */

import { defaultDeps, handleGithubTool, type GithubCtx, type GithubDeps } from "../tools/github-app";
import type { WorkRecord } from "./store";
import { baseForRepo } from "./config";
import { recordPushed, stageBranchForPush, stagedCommit } from "./workspace";

export interface PublisherDeps {
  /** The base branch pull requests are opened against when the repository has no entry in `repoBases`. */
  base: string;
  /** Per-repository base branches (anima #372); a repository without an entry uses `base`. */
  repoBases?: Record<string, string>;
  /** Defaults to the real tool; tests pass a recorder. */
  handle?: (args: Record<string, unknown>, ctx: GithubCtx) => Promise<string>;
  /** Directories Git may not read while it stages the branch (credentials). */
  denyReadRoots?: string[];
  /** Defaults to the real staging repository; tests pass stand-ins. */
  stage?: (work: WorkRecord) => { dir: string; sha: string };
  /**
   * The staging repository as the host left it (the host commit on the work branch), never re-fetched from the
   * author's Git directory: #390 records the host branch there, and a fetch would overwrite it with a branch
   * that has no such commit. Defaults to `<work.root>.push.git` and its HEAD commit.
   */
  stageExisting?: (work: WorkRecord) => { dir: string; sha: string };
  record?: (work: WorkRecord, sha: string) => void;
  /** Underlying HTTP / git / key access of the GitHub tool; tests pass scripted ones. */
  githubDeps?: Partial<GithubDeps>;
}

/**
 * `guard` throws when the session may no longer write (its lease is gone, or it no longer holds the work's
 * current generation). It is checked before the branch is staged and again immediately before every request or
 * `git push` that can change something on GitHub, after the token has been minted, so a lease lost while the
 * token was being fetched does not still write. It may be async (it can wait for a pending lease heartbeat);
 * every check awaits it. A check on the client cannot make lease ownership and a remote write atomic: a lease
 * lost after the last check and before the write lands is not visible from here.
 */
export type Guard = () => void | Promise<void>;
export type DraftPrArgs = { title: unknown; body: unknown };
export type Publisher = ((work: WorkRecord, args: Record<string, unknown>, guard?: Guard) => Promise<string>) & {
  openDraftPr(work: WorkRecord, args: DraftPrArgs, guard?: Guard): Promise<string>;
  /** Pushes the host's staging repository as it is; only the host can choose this, the model cannot (#392). */
  pushHostStaged(work: WorkRecord, guard?: Guard): Promise<string>;
};

const MAX_TITLE = 256;
const MAX_BODY = 60_000;

export function createPublisher(deps: PublisherDeps): Publisher {
  const handle = deps.handle ?? handleGithubTool;
  const options = { denyReadRoots: deps.denyReadRoots };
  const stage = deps.stage ?? ((work: WorkRecord) => {
    const dir = stageBranchForPush(work, options);
    return { dir, sha: stagedCommit(dir) };
  });
  const stageExisting = deps.stageExisting ?? ((work: WorkRecord) => {
    const dir = `${work.root}.push.git`;
    return { dir, sha: stagedCommit(dir) };
  });
  const record = deps.record ?? ((work: WorkRecord, sha: string) => recordPushed(work, sha, options));
  const context = (work: WorkRecord, dir: string, guard: Guard): GithubCtx => {
    const base: GithubDeps = { ...defaultDeps(), ...deps.githubDeps };
    return {
      agentName: work.author,
      cwd: dir,
      policy: { allowedTools: ["anima_github"], allowedRoots: [dir], readOnlyRoots: [] } as unknown as GithubCtx["policy"],
      deps: {
        ...deps.githubDeps,
        // The token exchange is not a write to the repository; everything after it is.
        fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const method = (init?.method ?? "GET").toUpperCase();
          if (method !== "GET" && method !== "HEAD" && !String(input).endsWith("/access_tokens")) await guard();
          return base.fetch(input, init);
        }) as typeof fetch,
        runGit: async (args, opts) => { await guard(); return base.runGit(args, opts); },
      },
    };
  };
  const publish: Publisher = async (work, args, guard = () => {}) => {
    try {
      await guard();
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    switch (args.action) {
      case "push": {
        let staged: { dir: string; sha: string };
        try {
          staged = stage(work);
        } catch (error) {
          return `Error: could not stage the branch for pushing: ${error instanceof Error ? error.message : String(error)}`;
        }
        const out = await handle({ action: "push", repo: work.repo, branch: work.branch, dir: staged.dir }, context(work, staged.dir, guard));
        if (pushed(out)) {
          try { record(work, staged.sha); } catch { /* the push happened; only the local note is missing */ }
        }
        return out;
      }
      case "open_pr": {
        return openPr(work, args.title, args.body, false, guard);
      }
      default:
        return `Error: unknown publish action ${JSON.stringify(String(args.action ?? ""))}; use push or open_pr`;
    }
  };
  publish.openDraftPr = async (work, args, guard = () => {}) => {
    try {
      await guard();
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    return openPr(work, args.title, args.body, true, guard);
  };
  publish.pushHostStaged = async (work, guard = () => {}) => {
    try {
      await guard();
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    let staged: { dir: string; sha: string };
    try {
      staged = stageExisting(work);
    } catch (error) {
      return `Error: could not stage the host branch for pushing: ${error instanceof Error ? error.message : String(error)}`;
    }
    return handle({ action: "push", repo: work.repo, branch: work.branch, dir: staged.dir }, context(work, staged.dir, guard));
  };
  return publish;

  function openPr(work: WorkRecord, title: unknown, body: unknown, draft: boolean, guard: Guard): Promise<string> | string {
    const pr = validatedPr(work, title, body);
    if (typeof pr === "string") return pr;
    const base = baseForRepo(deps.repoBases, deps.base, work.repo);
    return handle({ action: "pr_create", repo: work.repo, head: work.branch, base, ...pr, ...(draft ? { draft: true } : {}) }, context(work, `${work.root}/tree`, guard));
  }
}

function validatedPr(work: WorkRecord, title: unknown, body: unknown): { title: string; body: string } | string {
  if (typeof title !== "string" || title.trim() === "" || title.length > MAX_TITLE) return `Error: title must be a non-empty string of at most ${MAX_TITLE} characters`;
  if (typeof body !== "string" || body.length > MAX_BODY || !new RegExp(`\\bCloses #${work.issue}\\b`, "i").test(body)) {
    return `Error: the pull request body must contain "Closes #${work.issue}"`;
  }
  return { title, body };
}

function pushed(out: string): boolean {
  try { return (JSON.parse(out) as { status?: unknown }).status === "ok"; } catch { return false; }
}
