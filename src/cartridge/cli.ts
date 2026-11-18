import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CartridgeRegistry, validateEntry } from "./registry";

export interface CartridgeCliOptions {
  projectRoot?: string;
  globalRoot?: string;
  colonyRoot?: string;
  write?: (s: string) => void;
  error?: (s: string) => void;
}

export async function runCartridgeCli(argv: string[], opts: CartridgeCliOptions = {}): Promise<number> {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const error = opts.error ?? ((s: string) => process.stderr.write(s));
  const projectRoot = opts.projectRoot ?? process.cwd();
  const registry = new CartridgeRegistry({
    projectRoot,
    globalRoot: opts.globalRoot,
    colonyRoot: opts.colonyRoot,
  });
  const [sub, name] = argv;

  if (sub === "validate") {
    let failures = 0;
    for (const path of await findUnparseable(projectRoot, opts)) {
      failures++;
      error(`${path}: failed to parse (missing required frontmatter or malformed YAML)\n`);
    }
    const entries = await registry.list("_cli");
    const counts = new Map<string, number>();
    for (const entry of entries) {
      counts.set(entry.scope, (counts.get(entry.scope) ?? 0) + 1);
      const errors = validateEntry(entry);
      const check = await registry.budgetCheck(entry);
      if (check.over) errors.push(`over budget: ~${check.estimate} tokens > ${check.budget}`);
      if (errors.length > 0) {
        failures++;
        error(`${entry.path}: ${errors.join("; ")}\n`);
      }
    }
    for (const [scope, n] of counts) write(`${scope}: ${n}\n`);
    return failures > 0 ? 1 : 0;
  }

  if (sub === "expand") {
    if (!name) {
      error("usage: anima cartridge expand <name>\n");
      return 1;
    }
    const entries = await registry.list("_cli");
    const entry = entries.find((e) => e.name === name);
    if (!entry) {
      error(`cartridge "${name}" not found (searched colony, global, project, agent tiers)\n`);
      return 1;
    }
    write(`${await registry.expand(entry)}\n`);
    return 0;
  }

  if (sub === "list") {
    for (const e of await registry.list("_cli")) {
      write(`${e.scope}/${e.category}/${e.name}\t${e.path}\n`);
    }
    return 0;
  }

  error("usage: anima cartridge <validate|expand <name>|list>\n");
  return 1;
}

async function findUnparseable(projectRoot: string, opts: CartridgeCliOptions): Promise<string[]> {
  const roots = [opts.colonyRoot, opts.globalRoot, projectRoot].filter((r): r is string => !!r);
  const bad: string[] = [];
  for (const root of roots) {
    for (const sub of ["shared", "pluggable", "dynamic"]) {
      const dir = join(root, "cartridges", sub);
      if (!existsSync(dir)) continue;
      for (const file of await readdir(dir)) {
        if (!file.endsWith(".md")) continue;
        const path = join(dir, file);
        const raw = await Bun.file(path).text();
        const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        const hasName = match ? /(^|\n)name:\s*\S+/.test(match[1]) : false;
        const hasCategory = match ? /(^|\n)category:\s*\S+/.test(match[1]) : false;
        if (!match || !hasName || !hasCategory) bad.push(path);
      }
    }
  }
  return bad;
}
