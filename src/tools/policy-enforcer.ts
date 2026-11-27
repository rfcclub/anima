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
  /** With no path operand it reads piped input instead of walking the cwd (rg, ag; recursive grep still walks). */
  readsPipedInput?: boolean;
}

const always = () => true;
const shortFlagHas = (letters: RegExp, longs: string[]) => (flags: string[]) =>
  flags.some((f) => (/^-[A-Za-z0-9]+$/.test(f) && letters.test(f.slice(1))) || longs.includes(f.split("=")[0]!));

const GREP_SPEC: ScannerSpec = {
  recursive: shortFlagHas(/[rR]/, ["--recursive", "--dereference-recursive"]),
  valueFlags: new Set(["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--regexp", "--file", "--max-count", "--context", "--after-context", "--before-context", "--include", "--exclude", "--exclude-dir", "--label"]),
  patternFirst: new Set(["-e", "-f", "--regexp", "--file"]),
};
const SCANNERS: Record<string, ScannerSpec> = {
  find: { recursive: always, valueFlags: new Set(), findSyntax: true },
  grep: GREP_SPEC,
  egrep: GREP_SPEC,
  fgrep: GREP_SPEC,
  rg: {
    recursive: always,
    valueFlags: new Set(["-e", "-f", "-g", "-t", "-T", "-m", "-A", "-B", "-C", "-j", "-M", "-E", "-r", "--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--max-count", "--max-depth", "--threads", "--max-columns", "--context", "--after-context", "--before-context", "--type-add", "--sort", "--sortr", "--pre", "--encoding", "--engine", "--replace", "--colors"]),
    patternFirst: new Set(["-e", "-f", "--regexp", "--file", "--files", "--type-list"]),
    readsPipedInput: true,
  },
  ag: {
    recursive: always,
    valueFlags: new Set(["-A", "-B", "-C", "-m", "-G", "-g", "--ignore", "--file-search-regex", "--context", "--max-count"]),
    patternFirst: new Set([]),
    readsPipedInput: true,
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
/** Shell words that can stand before a command (then cd, do cd, ...). */
const SHELL_KEYWORDS = new Set(["then", "do", "else", "{", "!", "builtin"]);

function homeDir(): string {
  return process.env.HOME || homedir();
}

/** A scan rooted here walks the whole machine or another application's data, which makes macOS
 *  ask the owner for access on behalf of the server. Resolved per call from $HOME like the secrets rule. */
function isBroadScanRoot(path: string): boolean {
  const home = canonicalize(homeDir());
  const target = canonicalize(path);
  if (["/", "/Users", "/Volumes", "/System", "/private", dirname(home), home].includes(target)) return true;
  // launchd job definitions are ordinary configuration that agents read; nothing behind a privacy prompt lives there
  if (isPathInside(join(home, "Library", "LaunchAgents"), target)) return false;
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
function scanRoots(name: string, args: string[], cwd: string, stdinFed = false): string[] | undefined {
  // own keys only: a word such as "constructor" must not reach Object.prototype
  const spec = Object.hasOwn(SCANNERS, name) ? SCANNERS[name] : undefined;
  if (!spec) return undefined;
  const flags: string[] = [];
  const operands: string[] = [];
  let i = 0;
  if (spec.findSyntax) {
    while (i < args.length && /^-[EHLPXdsx]+$/.test(args[i]!)) flags.push(args[i++]!);
    if (args[i] === "--") i++;
    // BSD find -f <path> names a path that may look like an option
    while (args[i] === "-f" && i + 1 < args.length) { operands.push(args[i + 1]!); i += 2; }
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
  // find -maxdepth 0 or 1 lists one directory, like ls
  if (spec.findSyntax) {
    const depth = args.indexOf("-maxdepth");
    if (depth !== -1 && Number(args[depth + 1]) <= 1) return undefined;
  }
  const patternSupplied = spec.patternFirst && flags.some((f) => spec.patternFirst!.has(f.split("=")[0]!) || /^-[ef].+/.test(f));
  const paths = spec.patternFirst && !patternSupplied ? operands.slice(1) : operands;
  // rg and ag with no path operand read piped input (xargs supplies paths) instead of walking the cwd
  if (paths.length === 0 && stdinFed && spec.readsPipedInput) return undefined;
  return (paths.length ? paths : ["."]).map((p) => operandDir(p, cwd));
}

type ShellToken = { kind: "word"; text: string } | { kind: "sep"; text: string };

/** Split a command line into words and separators. Quotes group words and are removed; separators
 *  (newline ; && || | & ( ) $( and backtick) count only outside quotes. Not a shell parser. */
function shellTokens(command: string): ShellToken[] {
  const out: ShellToken[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  // the word after an unquoted redirection operator is its target (a file, or a heredoc delimiter), not an argument
  let dropNext = false;
  // $( ) and backticks inside double quotes still run: leave the quote, and resume it when the substitution closes
  let depth = 0;
  const resumeAt: number[] = [];
  let backtickResumes = false;
  const flush = () => {
    if (inWord) {
      if (dropNext) dropNext = false;
      else out.push({ kind: "word", text: word });
    }
    word = "";
    inWord = false;
  };
  const sep = (text: string) => {
    flush();
    dropNext = false;
    out.push({ kind: "sep", text });
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === '"' && command.startsWith("$(", i)) {
      quote = null;
      sep("$(");
      depth++;
      resumeAt.push(depth);
      i++;
      continue;
    }
    if (quote === '"' && ch === "`") {
      quote = null;
      sep("`");
      backtickResumes = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inWord = true; continue; }
    if (ch === "\\" && i + 1 < command.length) { word += command[++i]; inWord = true; continue; }
    if (ch === "<" || ch === ">") {
      // an unquoted redirection: a leading file-descriptor number belongs to it, then the operator, then its target
      if (/^\d+$/.test(word)) { word = ""; inWord = false; } else flush();
      let j = i;
      while (j + 1 < command.length && "<>".includes(command[j + 1]!)) j++;
      const dup = /^&\d*-?/.exec(command.slice(j + 1))?.[0] ?? "";
      i = j + dup.length;
      // <(...) and >(...) are process substitutions: the parenthesis opens a command, nothing to drop
      if (dup === "" && command[i + 1] !== "(") { dropNext = true; if (command[i + 1] === "-") i++; }
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "$(") {
      sep(two);
      if (two === "$(") depth++;
      i++;
      continue;
    }
    if (ch === "(") { sep(ch); depth++; continue; }
    if (ch === ")") {
      sep(ch);
      if (resumeAt[resumeAt.length - 1] === depth) { resumeAt.pop(); quote = '"'; inWord = true; }
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === "`") {
      sep(ch);
      if (backtickResumes) { backtickResumes = false; quote = '"'; inWord = true; }
      continue;
    }
    if ("\n;|&".includes(ch)) { sep(ch); continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    word += ch;
    inWord = true;
  }
  flush();
  return out;
}

/** Agent tools must not walk the home directory, the filesystem root or ~/Library: those scans reach
 *  other applications' data and make macOS prompt the owner. Unconditional, like the secrets rule.
 *  Scope: it catches accidental broad scans by cooperative agents. It is word matching on the command line
 *  (cd between segments is tracked), not a sandbox: shell indirection is out of scope (bash -c / sh -c / eval
 *  strings, variables other than HOME, aliases and functions, heredoc bodies). The target is the refused
 *  directory, never the command, so a refusal record carries no command text. */
export function checkBroadScan(input: { tool: string; args: Record<string, unknown>; cwd?: string }): PolicyDecision {
  const { tool, args } = input;
  const startCwd = input.cwd ?? process.cwd();
  if (tool === "bash") {
    let cwd = startCwd;
    // A cd inside a subshell or command substitution only moves the cwd until it closes.
    const saved: string[] = [];
    let inBacktick = false;
    let words: string[] = [];
    let piped = false;
    const checkSegment = (): PolicyDecision | undefined => {
      const segment = words;
      words = [];
      let i = 0;
      while (i < segment.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[i]!) || SHELL_KEYWORDS.has(segment[i]!))) i++;
      if (segment[i] === "cd") {
        const dest = segment[i + 1];
        if (dest === undefined) cwd = homeDir();
        else if (dest !== "-") cwd = operandDir(dest, cwd);
        return undefined;
      }
      // Any word naming a scanner starts a scan, wherever it sits (after sudo, env -i, xargs -P 4, then, ...).
      // A bare scanner name used as plain text (echo find ~) is refused too; the message says what to do instead.
      for (let j = 0; j < segment.length; j++) {
        const name = segment[j]!.split("/").pop() ?? "";
        const roots = scanRoots(name, segment.slice(j + 1), cwd, piped || segment[j - 1] === "xargs");
        const broad = roots?.find((r) => isBroadScanRoot(r));
        if (broad !== undefined) {
          return { allowed: false, rule: "broad-scan", reason: `${name} scans ${broad}, which reaches the home directory, the filesystem root or Library; scan a project directory instead`, target: broad };
        }
      }
      return undefined;
    };
    for (const token of shellTokens(String(args.command ?? ""))) {
      if (token.kind === "word") { words.push(token.text); continue; }
      const refused = checkSegment();
      if (refused) return refused;
      piped = token.text === "|";
      if (token.text === "(" || token.text === "$(") saved.push(cwd);
      else if (token.text === ")") cwd = saved.pop() ?? cwd;
      else if (token.text === "`") {
        if (inBacktick) cwd = saved.pop() ?? cwd;
        else saved.push(cwd);
        inBacktick = !inBacktick;
      }
    }
    return checkSegment() ?? { allowed: true };
  }
  if (!RECURSIVE_TOOLS.has(tool)) return { allowed: true };
  const raw = targetPath(tool, args, startCwd);
  if (raw === undefined) return { allowed: true };
  const expanded = raw.replace(/^~(?=\/|$)/, homeDir());
  let target = canonicalize(expanded || startCwd, startCwd);
  // a glob pattern can climb out of its cwd (../../**/*.plist): its fixed leading directories are where the walk starts
  if (tool === "glob" && typeof args.pattern === "string") target = canonicalize(operandDir(args.pattern, target));
  if (isBroadScanRoot(target)) {
    return { allowed: false, rule: "broad-scan", reason: `${tool} over ${target} scans too broadly; use a project directory`, target };
  }
  return { allowed: true };
}
