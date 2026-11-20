#!/usr/bin/env bun
/**
 * Deploy roster check. The deploy used to copy the checkout's data/colony.json over the runtime roster. The public
 * default branch carries a neutral sample roster, so deploying from it would replace the real roster. This chooses
 * which roster to install: a private overlay kept outside every repository, or the checkout roster when it is exactly
 * the runtime roster (or there is none yet). Anything else is refused before a file is touched, unless the change is
 * accepted on purpose (ANIMA_ACCEPT_ROSTER_CHANGE=1). Every candidate must be loadable by the server.
 *
 *   deploy-roster.ts choose <repo roster> <runtime roster> <overlay dir or ""> <project dir>   prints the chosen file
 *   deploy-roster.ts validate <staged file> [runtime roster]   exit 0 when loadable and, against the runtime roster, allowed
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export type RosterChoice = { action: "overlay" } | { action: "repo" } | { action: "refuse"; reason: string };

/** The server loads `agents` as an array of objects that carry a name. */
export function validRoster(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { agents?: unknown; companies?: unknown };
    const agents = parsed?.agents;
    const agentsOk = Array.isArray(agents) && agents.length > 0 &&
      agents.every((a) => a !== null && typeof a === "object" && typeof (a as { name?: unknown }).name === "string" && (a as { name: string }).name !== "");
    if (!agentsOk) return false;
    // The server reads every member's agentId: a null or id-less member would crash startup.
    const companies = parsed.companies;
    if (companies === undefined) return true;
    if (companies === null || typeof companies !== "object" || Array.isArray(companies)) return false;
    return Object.values(companies as Record<string, unknown>).every((company) => {
      const members = (company as { members?: unknown } | null)?.members;
      return members === undefined || (Array.isArray(members) && members.every((m) =>
        m !== null && typeof m === "object" && typeof (m as { agentId?: unknown }).agentId === "string"));
    });
  } catch {
    return false;
  }
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, sorted((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** The roster as canonical JSON: the same content in another key order is the same roster. */
export function canonicalRoster(text: string): string {
  return JSON.stringify(sorted(JSON.parse(text)));
}

export function chooseRoster(input: { repo: string; runtime: string | null; overlay?: string | null; accept?: boolean }): RosterChoice {
  const accept = input.accept === true;
  // An existing runtime roster that cannot be read as a roster is not "the same": replacing it needs the same consent.
  const differs = (candidate: string): boolean => {
    if (input.runtime === null) return false;
    try {
      return canonicalRoster(candidate) !== canonicalRoster(input.runtime);
    } catch {
      return true;
    }
  };
  if (input.overlay !== undefined && input.overlay !== null) {
    if (!validRoster(input.overlay)) return { action: "refuse", reason: "the overlay roster is not a roster the server can load" };
    if (differs(input.overlay) && !accept) {
      return { action: "refuse", reason: "the overlay roster differs from the runtime roster; set ANIMA_ACCEPT_ROSTER_CHANGE=1 if the change is intended" };
    }
    return { action: "overlay" };
  }
  if (!validRoster(input.repo)) return { action: "refuse", reason: "the repository roster is not a roster the server can load" };
  if (input.runtime === null) return { action: "repo" };
  if (!differs(input.repo) || accept) return { action: "repo" };
  return {
    action: "refuse",
    reason: "the build's roster differs from the runtime roster and no overlay is configured; set ANIMA_OVERLAY_DIR to a private directory holding colony.json (or ANIMA_ACCEPT_ROSTER_CHANGE=1 if the checkout roster is meant to replace it)",
  };
}

/** True when no group or other permission bit is set. */
export function isPrivateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

/** True when `child` is `parent` or inside it (a sibling that shares a prefix is not inside). */
export function isInsidePath(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

function fail(message: string): never {
  console.error(`refusing to deploy: ${message}`);
  process.exit(1);
}

function insideGitWorkTree(dir: string): boolean {
  const proc = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "ignore" });
  return proc.exitCode === 0 && new TextDecoder().decode(proc.stdout).trim() === "true";
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "validate") {
    // The staged bytes are what gets installed: decide again on exactly those bytes, so a source that changed after
    // the choice cannot install a different roster without consent.
    const [file, runtimeFile] = args;
    if (!file || !existsSync(file)) fail("no roster file to validate");
    const staged = readFileSync(file, "utf-8");
    if (!validRoster(staged)) fail("the staged roster is not a roster the server can load");
    const runtime = runtimeFile && existsSync(runtimeFile) ? readFileSync(runtimeFile, "utf-8") : null;
    const choice = chooseRoster({ repo: staged, runtime, accept: Bun.env.ANIMA_ACCEPT_ROSTER_CHANGE === "1" });
    if (choice.action === "refuse") fail(`the staged roster is not allowed: ${choice.reason}`);
    process.exit(0);
  }
  if (mode !== "choose") {
    console.error("usage: deploy-roster.ts choose <repo roster> <runtime roster> <overlay dir> <project dir> | validate <file>");
    process.exit(2);
  }
  const [repoFile, runtimeFile, overlayDir, projectDir] = args;
  if (!repoFile || !runtimeFile || !projectDir) fail("missing arguments");
  let overlayFile = "";
  if (overlayDir) {
    if (!existsSync(overlayDir)) fail("the overlay directory does not exist");
    const real = realpathSync(overlayDir);
    if (isInsidePath(real, realpathSync(projectDir)) || insideGitWorkTree(real)) {
      fail("the overlay directory is inside a repository; it must be private and outside every repository");
    }
    const declared = join(real, "colony.json");
    if (!existsSync(declared)) fail("the overlay directory has no colony.json");
    // The file may be a link: judge, and later read, the file it really is.
    overlayFile = realpathSync(declared);
    if (isInsidePath(overlayFile, realpathSync(projectDir)) || insideGitWorkTree(dirname(overlayFile))) {
      fail("the overlay roster file resolves to a path inside a repository; it must be outside every repository");
    }
    if (!isPrivateMode(statSync(real).mode) || !isPrivateMode(statSync(overlayFile).mode)) {
      fail("the overlay directory and its colony.json must not be readable by group or others (use mode 700 and 600)");
    }
  }
  const choice = chooseRoster({
    repo: readFileSync(repoFile, "utf-8"),
    runtime: existsSync(runtimeFile) ? readFileSync(runtimeFile, "utf-8") : null,
    overlay: overlayDir ? readFileSync(overlayFile, "utf-8") : undefined,
    accept: Bun.env.ANIMA_ACCEPT_ROSTER_CHANGE === "1",
  });
  if (choice.action === "refuse") fail(choice.reason);
  console.log(choice.action === "overlay" ? overlayFile : repoFile);
}
