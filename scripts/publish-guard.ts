#!/usr/bin/env bun
/**
 * Publish guard: checks a Git repository for data that must not leave the machine before it is pushed to, or made, public.
 *
 * Usage: bun scripts/publish-guard.ts <repo> [--public] [--history] [--json]
 *   --public   the repository is (or is about to be) public: also fail on non-English letters, warn on colony information
 *   --history  scan every commit on every ref, not only the commits reachable from HEAD. Without it only HEAD and the commits that
 *              tags point to are scanned, NOT their ancestors: a leak removed in an older commit is missed. Public mode implies it.
 *
 * Exit code 0: no errors. 1: at least one error. 2: the check itself could not run (for example Git failed): never read that as "clean".
 * It never prints a secret value: only rule, a redacted location and a masked hint.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Level = "error" | "warn";
export interface Finding { level: Level; rule: string; where: string; detail: string }
export interface GuardOptions {
  repo: string;
  publicMode: boolean;
  history: boolean;
  /** Files whose secret-looking values must not appear in the repository (default: this machine's credential files). */
  secretFiles?: string[];
}

/** Thrown when the check could not be performed. The caller must treat it as a failure, never as "nothing found". */
export class GuardError extends Error {}

const NOREPLY = /^(\d+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com$|^noreply@github\.com$|^noreply@anthropic\.com$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const HOME_PATH = "/(Users|home)/[A-Za-z0-9._-]+";
const PLACEHOLDER_USER = /^(user|username|runner|you|name|me|your-name|yourname|home)$/i;
const INTERNAL_FILE = [
  /(^|\/)node_modules\//, /(^|\/)\.harness\//, /(^|\/)evidence\//, /(^|\/)\.orca-(verify|red)\.json$/, /(^|\/)\.archive-meta\.json$/,
  /(^|\/)(delivery|self-check|rollout|rollback)\.md$/, /(^|\/)verification-evidence\.json$/, /(^|\/)AGENT_HANDOFF[^/]*$/,
  /(^|\/)\.env($|\.)/, /\.pem$/, /(^|\/)id_(rsa|ed25519)/, /(^|\/)mesh-jobs\.json$/, /(^|\/)work\.db$/, /(^|\/)\.netrc$/,
];
const SECRET_SHAPES: Array<[string, string]> = [
  ["github-token", "(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}"],
  ["api-key", "sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}"],
  ["private-key", "-----BEGIN [A-Z ]*PRIVATE KEY-----"],
];
const SHAPE_RX = SECRET_SHAPES.map(([, rx]) => new RegExp(rx, "g"));
const SECRET_KEY_NAME = /key|token|secret|pass|credential|auth|bearer|capability|private/i;
// Colony information. The names themselves (owner handle, agent names) are NOT kept in this file: a public copy of the guard
// would leak them. They are read from a local file, one name per line (# starts a comment), by default ~/.config/publish-guard/names.txt
// or PUBLISH_GUARD_NAMES_FILE. Matching is PCRE (git grep -P): POSIX ERE ignores \b on macOS, so -E silently skipped every name.
const BASE_COLONY = ["\\.anima\\b", "chat_id", "identity-runtime", "garden-?hub", "hindsight"];
const escapeRe = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);
/** The colony pattern and where the names came from; read at call time so the names file can change between runs. */
function colonyPattern(): { pattern: string; file: string; found: boolean } {
  const file = process.env.PUBLISH_GUARD_NAMES_FILE ?? join(homedir(), ".config", "publish-guard", "names.txt");
  const found = existsSync(file);
  const names = found ? readFileSync(file, "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean) : [];
  return { pattern: "(" + [...names.map((n) => "(?<![A-Za-z0-9])" + escapeRe(n) + "(?![A-Za-z0-9])"), ...BASE_COLONY].join("|") + ")", file, found };
}

interface GitResult { out: string }
/** Runs git and returns stdout. Any exit status outside `okCodes` (and any spawn error such as a full buffer) is a GuardError. */
function git(repo: string, args: string[], opts: { input?: string; okCodes?: number[]; locale?: string } = {}): GitResult {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", input: opts.input, maxBuffer: 512 * 1024 * 1024, env: { ...process.env, LC_ALL: opts.locale ?? "C.UTF-8" } });
  if (r.error) throw new GuardError("git could not run: " + r.error.message);
  if (!(opts.okCodes ?? [0]).includes(r.status ?? -1)) throw new GuardError("git " + args[0] + " failed (exit " + r.status + ") in " + repo);
  return { out: r.stdout ?? "" };
}

export function defaultSecretFiles(home = homedir()): string[] {
  const roots = [join(home, ".anima", "secrets"), join(home, ".anima", "auth"), join(home, ".anima", "providers.d")];
  const files: string[] = [];
  const walk = (p: string): void => {
    let st; try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e)); else files.push(p);
  };
  roots.forEach(walk);
  for (const f of [join(home, ".claude", "settings.json"), join(home, ".claude", "settings.local.json"), join(home, ".zshrc"), join(home, ".bashrc"), join(home, ".netrc")]) if (existsSync(f)) files.push(f);
  return files;
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/**
 * Secret-looking values in the given files: a string of at least 20 characters, no spaces, that is either stored under a key
 * whose name says secret (key, token, secret, password, ...) or looks random (mixed case with digits, or long hex). Plain model
 * identifiers, urls, paths and timestamps are not secrets and are left out.
 */
export function secretValues(files: string[]): string[] {
  const values = new Set<string>();
  const add = (s: string, keyName: string): void => {
    const v = s.trim().replace(/^["']|["']$/g, "");
    if (v.length < 20 || /\s/.test(v) || /^(https?:|\/|\.\/|file:)/.test(v) || !/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) return;
    const random = (/[A-Z]/.test(v) && /[a-z]/.test(v) && entropy(v) >= 3.6) || /^[0-9a-f]{32,}$/.test(v);
    if (SECRET_KEY_NAME.test(keyName) || random) values.add(v);
  };
  const walk = (o: unknown, keyName: string): void => {
    if (typeof o === "string") add(o, keyName);
    else if (Array.isArray(o)) o.forEach((x) => walk(x, keyName));
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, k);
  };
  for (const f of files) {
    let t: string; try { t = readFileSync(f, "utf8"); } catch { continue; }
    try { walk(JSON.parse(t), ""); } catch { /* not JSON */ }
    for (const m of t.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*["']?([A-Za-z0-9_\-./+=]{20,})/g)) add(m[2]!, m[1]!);
  }
  return [...values];
}

interface AllowEntry { rule: string; glob: RegExp }
/** Only these rules can be allowlisted: a secret, an email, a credential or evidence file is never an exception. */
const SUPPRESSIBLE = new Set(["non-english", "colony-info", "home-path", "binary-file"]);
/** `<rule> <path-pattern> # <reason>`: a reason is required, `*` stays inside one directory, `**` needs a directory prefix, a bare wildcard is refused. */
function allowList(repo: string, problems: Finding[], redact: (s: string) => string): AllowEntry[] {
  const f = join(repo, ".publish-guard-allow");
  if (!existsSync(f)) return [];
  const entries: AllowEntry[] = [];
  for (const raw of readFileSync(f, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [spec, ...why] = line.split("#");
    const [rule, pattern] = (spec ?? "").trim().split(/\s+/);
    const reason = why.join("#").trim();
    if (rule && !SUPPRESSIBLE.has(rule)) {
      problems.push({ level: "error", rule: "allowlist", where: ".publish-guard-allow", detail: "rule \"" + redact(rule).slice(0, 20) + "\" cannot be allowlisted (only " + [...SUPPRESSIBLE].join(", ") + ")" });
      continue;
    }
    if (!rule || !pattern || !reason || /^[*/.]*$/.test(pattern) || /^\*\*/.test(pattern)) {
      problems.push({ level: "error", rule: "allowlist", where: ".publish-guard-allow", detail: "entry needs <rule> <path> # <reason> and no bare wildcard: " + redact(line).slice(0, 60) });
      continue;
    }
    const rx = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
    entries.push({ rule, glob: new RegExp("^" + rx + "$") });
  }
  return entries;
}

export function runGuard(opts: GuardOptions): Finding[] {
  const { repo } = opts;
  if (!existsSync(repo)) throw new GuardError("not found: " + repo);
  const findings: Finding[] = [];
  const bare = git(repo, ["rev-parse", "--is-bare-repository"]).out.trim() === "true";
  if (!bare && realpathSync(git(repo, ["rev-parse", "--show-toplevel"]).out.trim()) !== realpathSync(repo)) throw new GuardError("not the top of a repository (a sub-directory of another one): " + repo);
  if (git(repo, ["rev-parse", "--is-shallow-repository"]).out.trim() === "true") throw new GuardError("shallow repository: the omitted history cannot be checked, fetch the full history first: " + repo);
  // publishing a repository publishes every commit reachable from what is pushed, so public mode always checks all of them
  const history = opts.history || opts.publicMode;
  const range = history ? ["--all"] : ["HEAD", "--tags"];
  const revs = git(repo, ["rev-list", ...range]).out.split("\n").filter(Boolean);
  if (revs.length === 0) throw new GuardError("no commits to check in " + repo);
  // without --history: the current tree, plus every commit a tag points to (git push --tags would publish those)
  const scanRevs = history ? revs : ["HEAD", ...git(repo, ["rev-list", "--no-walk", "--tags"]).out.split("\n").filter(Boolean)];
  const values = secretValues(opts.secretFiles ?? defaultSecretFiles());

  // a location is safe to print: secret shapes and known secret values are replaced
  const safe = (s: string): string => {
    let t = s;
    for (const rx of SHAPE_RX) t = t.replace(rx, "[redacted]");
    for (const v of values) if (t.includes(v)) t = t.split(v).join("[redacted]");
    return t.replace(EMAIL, (m) => (NOREPLY.test(m) ? m : m.replace(/^(.).*@/, "$1***@")));
  };
  const add = (level: Level, rule: string, where: string, detail: string): void => { findings.push({ level, rule, where: safe(where), detail }); };

  // 1. identities and messages: every author, committer and tagger address, and every address inside a message, must be a noreply address
  // NUL cannot occur in a commit message or an address, so it is the only safe field separator (a control byte can)
  const records = (out: string, fields: number): string[][] => {
    const parts = out.split("\0");
    if (parts[parts.length - 1] === "" || parts[parts.length - 1]!.trim() === "") parts.pop();
    if (parts.length % fields !== 0) throw new GuardError("unexpected git output while reading commits or tags");
    const rows: string[][] = [];
    for (let i = 0; i < parts.length; i += fields) rows.push(parts.slice(i, i + fields).map((p) => p.trim()));
    return rows;
  };
  const log = records(git(repo, ["log", ...range, "--format=%h%x00%ae%x00%ce%x00%B%x00"]).out, 4);
  const seenEmail = new Set<string>();
  const checkText = (where: string, text: string): void => {
    for (const m of text.matchAll(EMAIL)) {
      const e = m[0];
      if (NOREPLY.test(e) || seenEmail.has(e)) continue;
      seenEmail.add(e);
      add("error", "email", where, "address " + e.replace(/^(.).*@/, "$1***@") + " is not a GitHub noreply address");
    }
    for (const m of text.matchAll(new RegExp(HOME_PATH, "g"))) {
      const user = m[0].split("/")[2]!;
      if (!PLACEHOLDER_USER.test(user)) add("error", "home-path", where, "absolute path of a real user directory");
    }
    for (const [name, rx] of SECRET_SHAPES) if (new RegExp(rx).test(text)) add("error", "secret-shape", where, name);
    if (values.some((v) => text.includes(v))) add("error", "secret-value", where, "contains a value found in a local secrets file");
    if (opts.publicMode && [...text].some((c) => c.codePointAt(0)! > 127 && /\p{L}/u.test(c))) add("error", "non-english", where, "public repositories are English only");
  };
  for (const [sha, ae, ce, body] of log) checkText("commit " + sha, [ae, ce, body].join("\n"));
  const tags = records(git(repo, ["for-each-ref", "refs/tags", "--format=%(refname:short)%00%(taggeremail)%00%(contents)%00"]).out, 3);
  for (const [name, email, body] of tags) {
    checkText("tag " + name, [email, body].join("\n"));
    // a tag on a blob or tree publishes content the commit scans never reach
    const type = git(repo, ["cat-file", "-t", "refs/tags/" + name + "^{}"], { okCodes: [0, 128] }).out.trim();
    if (type !== "commit") add("error", "tag-target", "tag " + name, "points to a " + (type || "missing") + ", not a commit: it cannot be checked, delete the tag");
  }

  // helper: scan content of every revision with git grep; returns unique "path:line:text" hits (revision stripped)
  const grepAll = (flags: string[], pattern: string, stdinPatterns?: string, locale?: string, binary = false): string[] => {
    const hits = new Set<string>();
    for (let i = 0; i < scanRevs.length; i += 100) {
      const chunk = scanRevs.slice(i, i + 100);
      const args = ["grep", binary ? "-a" : "-I", ...flags, ...(stdinPatterns !== undefined ? ["-f", "-"] : ["-e", pattern]), ...chunk, "--", ":!node_modules"];
      for (const l of git(repo, args, { input: stdinPatterns, okCodes: [0, 1], locale }).out.split("\n").filter(Boolean)) hits.add(l.replace(/^(HEAD|[0-9a-f]{40}):/, ""));
    }
    return [...hits];
  };

  // 2. internal files tracked in any scanned revision
  const files = new Set<string>();
  for (const r of scanRevs) for (const f of git(repo, ["ls-tree", "-r", "--name-only", r]).out.split("\n")) if (f) files.add(f);
  for (const f of files) {
    if (INTERNAL_FILE.some((rx) => rx.test(f))) add("error", "internal-file", f, "evidence, handoff, receipt or credential file must be gitignored, not committed");
    for (const [name, rx] of SECRET_SHAPES) if (new RegExp(rx).test(f)) add("error", "secret-shape", f, name + " in a file name");
  }

  // 3. home directories of a real user: every match on a line counts, a placeholder earlier on the line does not hide a real one
  for (const hit of grepAll(["-nE"], HOME_PATH)) {
    const [path, line, ...rest] = hit.split(":");
    for (const m of rest.join(":").matchAll(new RegExp(HOME_PATH, "g"))) if (!PLACEHOLDER_USER.test(m[0].split("/")[2]!)) add("error", "home-path", path + ":" + line, "absolute path of a real user directory");
  }

  // 3a. binary files are published as they are, so the privacy rules apply to them too (git grep -I skips them). Only the files that
  // match in binary mode and not in text mode are reported here; the text pass above already covers the rest.
  const binaryOnly = (pattern: string): string[] => {
    const text = new Set(grepAll(["-lE"], pattern));
    return grepAll(["-lE"], pattern, undefined, undefined, true).filter((p) => !text.has(p));
  };
  for (const p of binaryOnly(HOME_PATH)) add("error", "home-path", p, "absolute path of a real user directory inside a binary file");
  for (const p of binaryOnly("[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}")) add("error", "email", p, "an email-shaped string inside a binary file (cannot be inspected; remove it or list the file in .publish-guard-allow with a reason)");

  // 3b. email addresses in file contents, judged on the whole line so the text before and after an address can be seen.
  // Fine: a reserved example domain, a clone URL (git@host:path, ssh://git@host/path), a scale-suffixed image name (icon@2x.png) or a
  // file name after a slash (/run/agent@m.cursor). A well-known placeholder domain (test.com, a.com, ...) is a warning; anything else
  // is an error.
  const PLACEHOLDER = /@(test|a|b|c|foo|bar)\.(com|org|net)$/i;
  const FILE_EXT = /\.(png|jpe?g|gif|svg|webp|ico|cursor|json|[cm]?[jt]sx?|md|txt|log|sock|pid|lock|ya?ml|toml|css|html?|woff2?|ttf|mp[34]|wav|webm)$/i;
  const SCALE_NAME = /@\d+(\.\d+)?x\.(png|jpe?g|gif|svg|webp|ico)$/i;
  const RESERVED = /@(example\.(com|org|net)|[A-Za-z0-9.-]+\.(invalid|test|local|example)|localhost)$/i;
  for (const hit of grepAll(["-nE"], "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}")) {
    const [path, line, ...rest] = hit.split(":");
    const text = rest.join(":");
    for (const m of text.matchAll(EMAIL)) {
      const e = m[0];
      const before = text.slice(0, m.index);
      const after = text.slice(m.index! + e.length);
      const local = e.split("@")[0]!;
      if (local === "git" && /^:[A-Za-z0-9~_.-]/.test(after) && !/[A-Za-z0-9._%+-]$/.test(before)) continue; // scp-style clone URL
      if (local === "git" && /^[:/]/.test(after) && /(^|[^A-Za-z0-9])(git\+)?ssh:\/\/$/.test(before)) continue; // ssh:// clone URL
      if (NOREPLY.test(e) || RESERVED.test(e) || SCALE_NAME.test(e) || (FILE_EXT.test(e) && /\/$/.test(before))) continue;
      add(PLACEHOLDER.test(e) ? "warn" : "error", "email", path + ":" + line, "address " + e.replace(/^(.).*@/, "$1***@") + " is not a GitHub noreply address");
    }
  }

  // 4. secret shapes and the real secret values on this machine; a binary file is searched too (GitHub publishes it as it is)
  for (const [name, rx] of SECRET_SHAPES) {
    for (const hit of grepAll(["-nE"], rx)) add("error", "secret-shape", hit.split(":").slice(0, 2).join(":"), name);
    for (const hit of grepAll(["-lE"], rx, undefined, undefined, true)) add("error", "secret-shape", hit, name + " (file content, binary or text)");
  }
  if (values.length > 0) {
    for (const hit of grepAll(["-lF"], "", values.join("\n") + "\n")) add("error", "secret-value", hit, "contains a value found in a local secrets file");
    for (const hit of grepAll(["-lF"], "", values.join("\n") + "\n", undefined, true)) add("error", "secret-value", hit, "contains a value found in a local secrets file");
  }

  // 5. public mode: any non-ASCII letter is non-English text; colony information is a warning. Only file names are listed (-c), so the
  // output stays small on a large repository instead of overflowing the buffer.
  if (opts.publicMode) {
    // a binary file cannot be read for personal data or language: list each one so it is a decision, not an oversight
    const textFiles = new Set(grepAll(["-l"], ""));
    const sized = new Set<string>();
    for (const r of scanRevs) for (const l of git(repo, ["ls-tree", "-r", "-l", r]).out.split("\n")) { const m = /^\d+ blob [0-9a-f]+ +(\d+)\t(.+)$/.exec(l); if (m && Number(m[1]) > 0) sized.add(m[2]!); }
    for (const p of sized) if (!textFiles.has(p)) add("warn", "binary-file", p, "binary file in a public repository: it cannot be inspected for personal data, confirm it is intended or list it in .publish-guard-allow with a reason");
    for (const hit of grepAll(["-cP"], "(?![\\x00-\\x7F])\\p{L}")) add("error", "non-english", hit.split(":")[0]!, "public repositories are English only (a non-ASCII letter)");
    const colony = colonyPattern();
    if (!colony.found) add("warn", "colony-info", colony.file, "names file not found: owner and agent names are not being checked");
    for (const hit of grepAll(["-ciP"], colony.pattern)) add("warn", "colony-info", hit.split(":")[0]!, "mentions an agent, the owner or colony infrastructure");
  }

  const problems: Finding[] = [];
  const allowed = allowList(repo, problems, safe);
  const seen = new Set<string>();
  return [...problems.map((p) => ({ ...p, detail: safe(p.detail) })), ...findings].filter((f) => {
    if (f.rule !== "allowlist" && allowed.some((a) => a.rule === f.rule && a.glob.test(f.where.split(":")[0]!))) return false;
    const key = f.rule + "|" + f.where + "|" + f.detail;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const repo = args.find((a) => !a.startsWith("--"));
  if (!repo) { console.error("usage: bun scripts/publish-guard.ts <repo> [--public] [--history] [--json]"); process.exit(2); }
  let findings: Finding[];
  try {
    findings = runGuard({ repo, publicMode: args.includes("--public"), history: args.includes("--history") });
  } catch (error) {
    console.error("publish guard could NOT run: " + (error instanceof Error ? error.message : String(error)) + " (this is not a pass)");
    process.exit(2);
  }
  if (args.includes("--json")) console.log(JSON.stringify(findings, null, 2));
  else for (const f of findings) console.log(f.level.toUpperCase().padEnd(5), f.rule.padEnd(14), f.where, "-", f.detail);
  const errors = findings.filter((f) => f.level === "error").length;
  console.error(errors === 0 ? "publish guard: no errors" + (findings.length ? " (" + findings.length + " warnings)" : "") : "publish guard: " + errors + " error(s), do not publish");
  process.exit(errors === 0 ? 0 : 1);
}
