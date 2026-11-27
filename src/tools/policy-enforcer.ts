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


interface ScannerSpec {
  /** True when the command walks a tree with these flags (always, for tree walkers). */
  recursive: (flags: string[]) => boolean;
  /** Flags that take the next word as their value. */
  valueFlags: Set<string>;
  /** The first operand is a search pattern, not a path, unless one of these flags supplies the pattern. */
  patternFirst?: Set<string>;
  /** find: leading option letters before the paths, and operands end at the first expression word. */
  findSyntax?: boolean;
}

const always = () => true;
const shortFlagHas = (letters: RegExp, longs: string[]) => (flags: string[]) =>
  flags.some((f) => (/^-[A-Za-z]+$/.test(f) && letters.test(f.slice(1))) || longs.includes(f.split("=")[0]!));

const GREP_SPEC: ScannerSpec = {
  recursive: shortFlagHas(/[rR]/, ["--recursive", "--dereference-recursive"]),
  valueFlags: new Set(["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--regexp", "--file", "--max-count", "--context", "--after-context", "--before-context", "--include", "--exclude", "--exclude-dir", "--label"]),
  patternFirst: new Set(["-e", "-f", "--regexp", "--file"]),
};
const SCANNERS: Record<string, ScannerSpec> = {
  find: { recursive: always, valueFlags: new Set(["-f"]), findSyntax: true },
  grep: GREP_SPEC,
  egrep: GREP_SPEC,
  fgrep: GREP_SPEC,
  rg: {
    recursive: always,
    valueFlags: new Set(["-e", "-f", "-g", "-t", "-T", "-m", "-A", "-B", "-C", "-j", "-M", "-E", "-r", "--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--max-count", "--max-depth", "--threads", "--max-columns", "--context", "--after-context", "--before-context", "--type-add", "--sort", "--sortr", "--pre", "--encoding", "--engine", "--replace", "--colors"]),
    patternFirst: new Set(["-e", "-f", "--regexp", "--file", "--files", "--type-list"]),
  },
  ag: {
    recursive: always,
    valueFlags: new Set(["-A", "-B", "-C", "-m", "-G", "-g", "--ignore", "--file-search-regex", "--context", "--max-count"]),
    patternFirst: new Set([]),
  },
  fd: {
    recursive: always,
    valueFlags: new Set(["-e", "-t", "-E", "-d", "-x", "-X", "-j", "-S", "-o", "-c", "--extension", "--type", "--exclude", "--max-depth", "--min-depth", "--exact-depth", "--exec", "--exec-batch", "--threads", "--size", "--changed-within", "--changed-before", "--owner", "--color", "--base-directory", "--search-path"]),
    patternFirst: new Set(["--search-path"]),
  },
  du: { recursive: always, valueFlags: new Set(["-d", "-B", "-t", "-I", "--max-depth", "--exclude"]) },
  tree: { recursive: always, valueFlags: new Set(["-L", "-I", "-P", "-o", "-H", "--filelimit"]) },
  ls: { recursive: shortFlagHas(/R/, ["--recursive"]), valueFlags: new Set(["-w", "-I", "--ignore", "--hide", "--width"]) },
};
/** Words that run the next word as the command. */
const COMMAND_PREFIXES = new Set(["sudo", "command", "exec", "nice", "time", "xargs", "nohup", "env"]);
/** Prefix options that take the next word as their value. */
const PREFIX_VALUE_FLAGS = new Set(["-u", "-n", "-g", "-C"]);

function homeDir(): string {
  return process.env.HOME || homedir();
}

/** A scan rooted here walks the whole machine or another application's data, which makes macOS
 *  ask the owner for access on behalf of the server. Resolved per call from $HOME like the secrets rule. */
function isBroadScanRoot(path: string): boolean {
  const home = canonicalize(homeDir());
  const target = canonicalize(path);
  if (["/", "/Users", "/Volumes", "/System", "/private", dirname(home), home].includes(target)) return true;
  return isPathInside(join(home, "Library"), target);
}

function unquote(word: string): string {
  return word.replace(/^["']+|["']+$/g, "");
}

/** The directory a path operand walks: ~ and $HOME expanded, trailing glob segments dropped, relative words resolved against cwd. */
function operandDir(word: string, cwd: string): string {
  const w = unquote(word).replace(/^(?:~|\$\{HOME\}|\$HOME)(?=\/|$)/, homeDir());
  const parts = w.split("/");
  const glob = parts.findIndex((p) => /[*?[]/.test(p));
  const kept = glob === -1 ? w : parts.slice(0, glob).join("/");
  if (kept === "") return w.startsWith("/") ? "/" : cwd;
  return isAbsolute(kept) ? resolve(kept) : resolve(cwd, kept);
}

/** The path operands of one scanner call, or the cwd when it names none. Undefined when the call is not a recursive scan. */
function scanRoots(name: string, args: string[], cwd: string): string[] | undefined {
  const spec = SCANNERS[name];
  if (!spec) return undefined;
  const flags: string[] = [];
  const operands: string[] = [];
  let i = 0;
  if (spec.findSyntax) {
    while (i < args.length && /^-[EHLPXdsx]+$/.test(args[i]!)) flags.push(args[i++]!);
    while (i < args.length && !/^[-(!]/.test(args[i]!)) operands.push(args[i++]!);
  } else {
    let endOfFlags = false;
    for (; i < args.length; i++) {
      const word = args[i]!;
      if (!endOfFlags && word === "--") { endOfFlags = true; continue; }
      if (!endOfFlags && word.startsWith("-") && word.length > 1) {
        flags.push(word);
        if (spec.valueFlags.has(word)) {
          const value = args[++i];
          if (value !== undefined && (word === "--search-path" || word === "--base-directory")) operands.push(value);
        }
        continue;
      }
      operands.push(word);
    }
  }
  if (!spec.recursive(flags)) return undefined;
  const patternSupplied = spec.patternFirst && flags.some((f) => spec.patternFirst!.has(f.split("=")[0]!) || /^-[ef].+/.test(f));
  const paths = spec.patternFirst && !patternSupplied ? operands.slice(1) : operands;
  return (paths.length ? paths : ["."]).map((p) => operandDir(p, cwd));
}

/** Agent tools must not walk the home directory, the filesystem root or ~/Library: those scans reach
 *  other applications' data and make macOS prompt the owner. Unconditional, like the secrets rule.
 *  Best-effort word matching on bash (tracks cd between segments), not a sandbox. The target is the
 *  refused directory, never the command, so a refusal record carries no command text. */
export function checkBroadScan(input: { tool: string; args: Record<string, unknown>; cwd?: string }): PolicyDecision {
  const { tool, args } = input;
  const startCwd = input.cwd ?? process.cwd();
  if (tool === "bash") {
    const command = String(args.command ?? "");
    let cwd = startCwd;
    // A cd inside a subshell or command substitution only moves the cwd until it closes.
    const saved: string[] = [];
    let inBacktick = false;
    for (const segment of command.split(/(\n|;|&&|\|\||\||&|\$\(|`|\(|\))/)) {
      if (segment === "(" || segment === "$(") { saved.push(cwd); continue; }
      if (segment === ")") { cwd = saved.pop() ?? cwd; continue; }
      if (segment === "`") {
        if (inBacktick) cwd = saved.pop() ?? cwd;
        else saved.push(cwd);
        inBacktick = !inBacktick;
        continue;
      }
      const words = segment.trim().split(/\s+/).filter(Boolean);
      let i = 0;
      let afterPrefix = false;
      while (i < words.length) {
        const word = words[i]!;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { i++; continue; }
        if (COMMAND_PREFIXES.has(word)) { afterPrefix = true; i++; continue; }
        // options of a prefix (env -i, nice -n 5, sudo -u user) are skipped with their value
        if (afterPrefix && word.startsWith("-")) { i += PREFIX_VALUE_FLAGS.has(word) ? 2 : 1; continue; }
        break;
      }
      const name = words[i]?.split("/").pop() ?? "";
      if (name === "cd") {
        const dest = words[i + 1];
        if (dest === undefined) cwd = homeDir();
        else if (dest !== "-") cwd = operandDir(dest, cwd);
        continue;
      }
      const roots = scanRoots(name, words.slice(i + 1), cwd);
      const broad = roots?.find((r) => isBroadScanRoot(r));
      if (broad !== undefined) {
        return { allowed: false, rule: "broad-scan", reason: `${name} scans ${broad}, which reaches the home directory, the filesystem root or Library; scan a project directory instead`, target: broad };
      }
    }
    return { allowed: true };
  }
  if (!RECURSIVE_TOOLS.has(tool)) return { allowed: true };
  const raw = targetPath(tool, args, startCwd);
  if (raw === undefined) return { allowed: true };
  const expanded = raw.replace(/^~(?=\/|$)/, homeDir());
  const target = canonicalize(expanded || startCwd, startCwd);
  if (isBroadScanRoot(target)) {
    return { allowed: false, rule: "broad-scan", reason: `${tool} over ${target} scans too broadly; use a project directory`, target };
  }
  return { allowed: true };
}
