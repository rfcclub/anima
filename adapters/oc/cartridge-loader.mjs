// Minimal cartridge loader for OpenClaw agents. Zero deps — parses only the
// required frontmatter keys (name, category); unknown fields are ignored.
// Priority: agent-local dir > colony tier (~/agora/cartridges).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function parse(path) {
  const raw = readFileSync(path, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  const name = match[1].match(/(^|\n)name:\s*(\S+)/)?.[2];
  const category = match[1].match(/(^|\n)category:\s*(\S+)/)?.[2];
  if (!name || !category) return null;
  return { name, category, content: match[2].trim(), path };
}

function scan(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parse(join(dir, f)))
    .filter(Boolean);
}

export function loadCartridge(name, opts = {}) {
  const colonyRoot = opts.colonyRoot ?? join(homedir(), "agora");
  const dirs = [
    join(colonyRoot, "cartridges", "shared"),
    join(colonyRoot, "cartridges", "pluggable"),
  ];
  if (opts.localDir) dirs.push(opts.localDir); // scanned last = wins
  let found = null;
  for (const dir of dirs) {
    for (const entry of scan(dir)) {
      if (entry.name === name) found = entry; // later dirs override
    }
  }
  return found;
}
