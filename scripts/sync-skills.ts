import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const skillNames = ["apply-change", "archive-change", "explore", "propose"].map(n => `openspec-${n}`);
const agents = [".agent", ".claude", ".codex", ".factory", ".gemini", ".qwen"];
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Manifest = { version: 1; hashes: Record<string, string> };

/** Local repository maintenance: refuses conflicting copies; not a concurrent filesystem sandbox. */
export function syncSkills(repo: string, options: { check?: boolean } = {}): { copies: number } {
  const root = resolve(repo);
  function inspect(path: string, kind: "file" | "dir", optional = false): boolean {
    const parts = relative(root, path).split(/[\\/]/).filter(Boolean);
    let current = root;
    for (let i = -1; i < parts.length; i++) {
      if (i >= 0) current = join(current, parts[i]!);
      let stat;
      try { stat = lstatSync(current); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && optional) return false;
        throw new Error(`Missing required ${kind}: ${path}`, { cause: error });
      }
      if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`);
      const final = i === parts.length - 1;
      if (!(final && kind === "file" ? stat.isFile() : stat.isDirectory())) {
        throw new Error(`Expected ${final ? kind : "dir"}: ${current}`);
      }
    }
    return true;
  }
  const sources = skillNames.map(name => {
    const dir = join(root, "skills", name), path = join(dir, "SKILL.md");
    inspect(dir, "dir");
    if (readdirSync(dir).filter(entry => entry !== ".DS_Store").join("\n") !== "SKILL.md") throw new Error(`Expected single SKILL.md, unexpected canonical assets in ${dir}`);
    inspect(join(dir, ".DS_Store"), "file", true);
    inspect(path, "file");
    const bytes = readFileSync(path); return { name, bytes, digest: hash(bytes) };
  });
  const manifest: Manifest = { version: 1, hashes: Object.fromEntries(sources.map(s => [s.name, s.digest])) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const writes: { path: string; bytes: Buffer }[] = [];
  for (const agent of agents) {
    const dir = join(root, agent, "skills"), manifestPath = join(dir, ".openspec-sync.json");
    let prior: Manifest | undefined;
    if (inspect(manifestPath, "file", true)) {
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (parsed?.version !== 1 || !parsed.hashes || typeof parsed.hashes !== "object" ||
          Object.keys(parsed.hashes).length !== skillNames.length ||
          !skillNames.every(n => typeof parsed.hashes[n] === "string" && /^[a-f0-9]{64}$/.test(parsed.hashes[n]))) throw new Error("Invalid shape");
        prior = parsed;
      } catch (error) { throw new Error(`Invalid sync manifest: ${manifestPath}`, { cause: error }); }
    }
    for (const source of sources) {
      const path = join(dir, source.name, "SKILL.md");
      if (inspect(path, "file", true)) {
        const digest = hash(readFileSync(path));
        if (digest === source.digest) continue;
        if (digest !== prior?.hashes[source.name]) {
          throw new Error(`Refusing edited or unmanaged skill: ${path}. Reconcile with skills/${source.name}/SKILL.md manually, then rerun skills:sync.`);
        }
      }
      writes.push({ path, bytes: source.bytes });
    }
    if (!prior || skillNames.some(n => prior!.hashes[n] !== manifest.hashes[n])) writes.push({ path: manifestPath, bytes: manifestBytes });
  }
  if (options.check && writes.length) throw new Error(`Missing or stale generated skills: ${writes.map(w => relative(root, w.path)).join(", ")}. Run bun run skills:sync.`);
  for (const { path, bytes } of writes) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.openspec-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, bytes, { flag: "wx", mode: 0o644 });
      renameSync(temp, path);
    } finally { rmSync(temp, { force: true }); }
  }
  return { copies: sources.length * agents.length };
}

if (import.meta.main) {
  try {
    if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("Usage: bun scripts/sync-skills.ts [--check]");
    const result = syncSkills(resolve(import.meta.dir, ".."), { check: process.argv.includes("--check") });
    console.log(`OpenSpec skills ${process.argv.includes("--check") ? "checked" : "synced"}: ${result.copies} copies`);
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
