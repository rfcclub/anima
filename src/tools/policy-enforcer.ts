import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ToolPolicy } from "../config/types";

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; rule: PolicyRule; reason: string; target: string };

export type PolicyRule = "outside-roots" | "read-only-root" | "denied-pattern" | "cwd-outside-roots" | "secrets-path" | "broad-scan";

export interface PolicyCheckInput {
  tool: string;
  args: Record<string, unknown>;
  policy: ToolPolicy;
  cwd?: string;
}

/** True when `target` is `root` or lives under it. Lexical; canonicalize first for symlinks. */
export function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Expand `~/`, resolve against cwd, then realpath the nearest existing ancestor so
 *  symlinks cannot escape a root and not-yet-existing files still resolve. */
export function canonicalize(path: string, cwd?: string): string {
  const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd ?? process.cwd(), expanded);
  let existing = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...tail.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return abs;
      tail.push(existing.slice(parent.length).replace(/^[\\/]/, ""));
      existing = parent;
    }
  }
}

function canonicalRoots(roots: string[] | undefined): string[] {
  return (roots ?? []).map((r) => canonicalize(r));
}

function matchesPattern(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return text.includes(pattern);
  }
}

const READ_TOOLS = new Set(["read", "grep", "glob"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

function targetPath(tool: string, args: Record<string, unknown>, cwd?: string): string | undefined {
  switch (tool) {
    case "read":
    case "write":
    case "edit":
      return String(args.path ?? "");
    case "grep":
      return args.path ? String(args.path) : (cwd ?? process.cwd());
    case "glob":
      return args.cwd ? String(args.cwd) : (cwd ?? process.cwd());
    case "task":
      return join(cwd ?? process.cwd(), "tasks.md");
    default:
      return undefined;
  }
}

/** Decide whether a tool call is allowed by the agent's policy. Pure; callers decide
 *  what to do with a denial (warn or block). Bash checks are pattern matching, not a sandbox. */
export function checkPolicy(input: PolicyCheckInput): PolicyDecision {
  const { tool, args, policy, cwd } = input;
  const allowedRoots = canonicalRoots(policy.allowedRoots);
  const readOnlyRoots = canonicalRoots(policy.readOnlyRoots);

  if (tool === "bash") {
    const command = String(args.command ?? "");
    for (const pattern of policy.deniedPatterns ?? []) {
      if (matchesPattern(pattern, command)) {
        return { allowed: false, rule: "denied-pattern", reason: `command matches denied pattern ${pattern}`, target: command };
      }
    }
    const dir = canonicalize(cwd ?? process.cwd());
    if (!allowedRoots.some((r) => isPathInside(r, dir))) {
      return { allowed: false, rule: "cwd-outside-roots", reason: `cwd ${dir} is outside allowedRoots`, target: dir };
    }
    return { allowed: true };
  }

  const raw = targetPath(tool, args, cwd);
  if (raw === undefined) return { allowed: true };

  const target = canonicalize(raw || (cwd ?? process.cwd()), cwd);
  const inAllowed = allowedRoots.some((r) => isPathInside(r, target));
  const inReadOnly = readOnlyRoots.some((r) => isPathInside(r, target));

  if (WRITE_TOOLS.has(tool) || tool === "task") {
    if (inAllowed) return { allowed: true };
    if (inReadOnly) {
      return { allowed: false, rule: "read-only-root", reason: `${tool} to ${target} is under a read-only root`, target };
    }
    return { allowed: false, rule: "outside-roots", reason: `${target} is outside allowedRoots`, target };
  }
  if (READ_TOOLS.has(tool)) {
    if (inAllowed || inReadOnly) return { allowed: true };
    return { allowed: false, rule: "outside-roots", reason: `${target} is outside allowedRoots and readOnlyRoots`, target };
  }
  return { allowed: true };
}

const SECRETS_TOOLS = new Set(["read", "write", "edit", "grep", "glob"]);
const RECURSIVE_TOOLS = new Set(["grep", "glob"]);
/** Best-effort: names the secrets dir in a command line. Not a sandbox; trivially bypassed by indirection. */
const SECRETS_IN_COMMAND = /(?:\.anima|ANIMA_HOME\}?)["']?[\\/]+secrets/;

/** Agent tools must never touch the agent GitHub App keys. Unconditional: ignores `policy.enforce`
 *  and works with no policy. Resolved per call from $HOME (os.homedir() ignores runtime HOME changes in Bun) so tests can use a throwaway home. */
export function checkSecretsPath(input: { tool: string; args: Record<string, unknown>; cwd?: string }): PolicyDecision {
  const { tool, args, cwd } = input;
  if (tool === "bash") {
    const command = String(args.command ?? "");
    if (SECRETS_IN_COMMAND.test(command)) {
      return { allowed: false, rule: "secrets-path", reason: "command names the secrets directory", target: command };
    }
    return { allowed: true };
  }
  if (!SECRETS_TOOLS.has(tool)) return { allowed: true };
  const raw = targetPath(tool, args, cwd);
  if (raw === undefined) return { allowed: true };
  const target = canonicalize(raw || (cwd ?? process.cwd()), cwd);
  const secrets = canonicalize(join(process.env.HOME || homedir(), ".anima", "secrets"));
  const inside = isPathInside(secrets, target);
  const ancestor = RECURSIVE_TOOLS.has(tool) && isPathInside(target, secrets);
  if (inside || ancestor) {
    return { allowed: false, rule: "secrets-path", reason: `${tool} reaches the secrets directory`, target };
  }
  return { allowed: true };
}

/** Commands that walk a directory tree on their own. */
const TREE_SCANNERS = new Set(["find", "fd", "rg", "ag", "du", "tree", "mdfind"]);
/** Commands that walk a tree only with a recursive flag. */
const FLAG_SCANNERS = new Set(["grep", "egrep", "fgrep", "ls"]);
const RECURSIVE_FLAG = /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)$/;
/** Words that run the next word as the command. */
const COMMAND_PREFIXES = new Set(["sudo", "command", "exec", "nice", "time", "xargs", "nohup"]);

/** A scan rooted here walks the whole machine or another application's data, which makes macOS
 *  ask the owner for access on behalf of the server. Resolved per call from $HOME like the secrets rule. */
function isBroadScanRoot(path: string): boolean {
  const home = canonicalize(process.env.HOME || homedir());
  const target = canonicalize(path);
  if (["/", "/Users", "/Volumes", "/System", "/private", dirname(home)].includes(target)) return true;
  if (target === home) return true;
  return isPathInside(join(home, "Library"), target);
}

function unquote(word: string): string {
  return word.replace(/^["']+|["']+$/g, "");
}

/** Expand a leading ~ or $HOME; resolve dot paths against cwd. Undefined when the word is not a path. */
function pathWord(word: string, cwd?: string): string | undefined {
  const home = process.env.HOME || homedir();
  const w = unquote(word).replace(/\/\*+$/, "/");
  const expanded = w.replace(/^(?:~|\$\{HOME\}|\$HOME)(?=\/|$)/, home);
  if (expanded.startsWith("/")) return expanded;
  if (expanded === "." || expanded === ".." || expanded.startsWith("./") || expanded.startsWith("../")) {
    return resolve(cwd ?? process.cwd(), expanded);
  }
  return undefined;
}

/** True when one simple command (already split into words) is a recursive scan of a broad root. */
function segmentScansBroadly(words: string[], cwd?: string): boolean {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || COMMAND_PREFIXES.has(words[i]!))) i++;
  const name = words[i]?.split("/").pop() ?? "";
  const rest = words.slice(i + 1);
  const scanning = TREE_SCANNERS.has(name) || (FLAG_SCANNERS.has(name) && rest.some((w) => RECURSIVE_FLAG.test(w)));
  if (!scanning) return false;
  return rest.some((w) => {
    const path = pathWord(w, cwd);
    return path !== undefined && isBroadScanRoot(path);
  });
}

/** Agent tools must not walk the home directory, the filesystem root or ~/Library: those scans reach
 *  other applications' data and make macOS prompt the owner. Unconditional, like the secrets rule.
 *  Best-effort pattern matching on bash, not a sandbox. */
export function checkBroadScan(input: { tool: string; args: Record<string, unknown>; cwd?: string }): PolicyDecision {
  const { tool, args, cwd } = input;
  if (tool === "bash") {
    const command = String(args.command ?? "");
    const segments = command.split(/\n|;|&&|\|\||\||&|\$\(|`|\(|\)/);
    for (const segment of segments) {
      const words = segment.trim().split(/\s+/).filter(Boolean);
      if (segmentScansBroadly(words, cwd)) {
        return { allowed: false, rule: "broad-scan", reason: "command scans the home directory, the filesystem root or Library; scan a project directory instead", target: command };
      }
    }
    return { allowed: true };
  }
  if (!RECURSIVE_TOOLS.has(tool)) return { allowed: true };
  const raw = targetPath(tool, args, cwd);
  if (raw === undefined) return { allowed: true };
  const expanded = raw.replace(/^~(?=\/|$)/, process.env.HOME || homedir());
  const target = canonicalize(expanded || (cwd ?? process.cwd()), cwd);
  if (isBroadScanRoot(target)) {
    return { allowed: false, rule: "broad-scan", reason: `${tool} over ${target} scans too broadly; use a project directory`, target };
  }
  return { allowed: true };
}
