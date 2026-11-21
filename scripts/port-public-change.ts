#!/usr/bin/env bun
/**
 * Port a change merged on the public default branch to the checkout that is deployed.
 *
 * The public history uses neutral placeholder names; the deployed line uses the real ones. A change cannot simply be
 * merged across, but a small patch can be translated: the placeholder names in the patch are replaced by the real
 * ones from a private mapping (kept outside every repository), and the result is applied with a three-way merge. A
 * patch whose context lines still apply to the deployed files has proven the mapping for the lines it touches; one
 * that does not apply is reported, never forced.
 *
 *   port-public-change.ts --source <public checkout> --change <commit> --target <deployed checkout> --map <file> [--paths src,scripts]
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type NameMap = Record<string, string>;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Replace placeholder names by real names in lower, Capitalized and UPPER case. A name is replaced as a whole word
 * (underscore, hyphen, dot and camelCase joins count as word boundaries); a longer word that merely contains it is not.
 */
export function reverseMapText(text: string, placeholderToReal: NameMap): string {
  const entries = Object.entries(placeholderToReal).sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [placeholder, real] of entries) {
    const p = escapeRe(placeholder);
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${p}(?![a-z0-9])`, "g"), real);
    out = out.replace(new RegExp(`(?<![A-Z0-9])${escapeRe(capitalize(placeholder))}(?![a-z0-9])`, "g"), capitalize(real));
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(placeholder.toUpperCase())}(?![A-Za-z0-9])`, "g"), real.toUpperCase());
  }
  return out;
}

function git(cwd: string, args: string[], input?: string): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", ...(input !== undefined ? { stdin: new TextEncoder().encode(input) } : {}) });
  return { code: proc.exitCode ?? -1, out: new TextDecoder().decode(proc.stdout), err: new TextDecoder().decode(proc.stderr) };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const source = arg("source"); const change = arg("change"); const target = arg("target"); const mapFile = arg("map");
  const paths = (arg("paths") ?? "src,scripts").split(",").filter(Boolean);
  if (!source || !change || !target || !mapFile) {
    console.error("usage: port-public-change.ts --source <public checkout> --change <commit> --target <deployed checkout> --map <file> [--paths src,scripts]");
    process.exit(2);
  }
  if (!existsSync(mapFile)) { console.error("the name map does not exist"); process.exit(2); }
  const map = (JSON.parse(readFileSync(mapFile, "utf-8")) as { placeholderToReal?: NameMap }).placeholderToReal;
  if (!map || Object.keys(map).length === 0) { console.error("the name map has no placeholderToReal entries"); process.exit(2); }
  if (git(target, ["status", "--porcelain"]).out.trim() !== "") { console.error("the target checkout is not clean"); process.exit(1); }

  const subject = git(source, ["log", "-1", "--format=%s", change]).out.trim();
  const diff = git(source, ["diff", "--binary", `${change}^`, change, "--", ...paths]);
  if (diff.code !== 0) { console.error(`could not read the change: ${diff.err.trim()}`); process.exit(1); }
  if (diff.out.trim() === "") { console.log("the change touches none of the ported paths; nothing to do"); process.exit(0); }
  const patch = reverseMapText(diff.out, map);
  const file = join(mkdtempSync(join(tmpdir(), "port-")), "change.patch");
  writeFileSync(file, patch);
  const check = git(target, ["apply", "--3way", "--check", file]);
  if (check.code !== 0) {
    console.error(`the translated patch does not apply to the target:\n${check.err.trim()}`);
    process.exit(1);
  }
  const applied = git(target, ["apply", "--3way", file]);
  if (applied.code !== 0) { console.error(`apply failed: ${applied.err.trim()}`); process.exit(1); }
  git(target, ["add", "-A", ...paths]);
  const commit = git(target, ["commit", "-q", "-m", `port: ${subject}\n\nTranslated from public commit ${change.slice(0, 10)}; kept on the deployed line only.`]);
  if (commit.code !== 0) { console.error(`commit failed: ${commit.err.trim()}`); process.exit(1); }
  console.log(`ported ${change.slice(0, 10)}: ${subject}`);
}
