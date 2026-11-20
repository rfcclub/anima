#!/usr/bin/env bun
/**
 * Deploy roster check. The deploy used to copy the checkout's data/colony.json over the runtime roster. The public
 * default branch carries a neutral sample roster, so deploying from it would replace the real roster. This chooses
 * which roster to install: a private overlay kept outside every repository, or the checkout roster when it is exactly
 * the runtime roster (or there is none yet). Anything else is refused before a file is touched, unless the change is
 * accepted on purpose (ANIMA_ACCEPT_ROSTER_CHANGE=1). Every candidate must be loadable by the server.
 *
 *   deploy-roster.ts choose <repo roster> <runtime roster> <overlay dir or ""> <project dir>   prints the chosen file
 *   deploy-roster.ts validate <roster file>                                                    exit 0 when loadable
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export type RosterChoice = { action: "overlay" } | { action: "repo" } | { action: "refuse"; reason: string };

/** The server loads `agents` as an array of objects that carry a name. */
export function validRoster(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { agents?: unknown };
    const agents = parsed?.agents;
    return Array.isArray(agents) && agents.length > 0 &&
      agents.every((a) => a !== null && typeof a === "object" && typeof (a as { name?: unknown }).name === "string" && (a as { name: string }).name !== "");
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
  const differs = (candidate: string): boolean => input.runtime !== null && validRoster(input.runtime) && canonicalRoster(candidate) !== canonicalRoster(input.runtime);
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
    const [file] = args;
    if (!file || !existsSync(file)) fail("no roster file to validate");
    if (!validRoster(readFileSync(file, "utf-8"))) fail("the staged roster is not a roster the server can load");
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
    overlayFile = join(real, "colony.json");
    if (!existsSync(overlayFile)) fail("the overlay directory has no colony.json");
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
