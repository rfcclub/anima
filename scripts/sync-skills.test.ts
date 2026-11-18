import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSkills } from "./sync-skills";

const names = ["apply-change", "archive-change", "explore", "propose"].map(n => `openspec-${n}`);
const agents = [".agent", ".claude", ".codex", ".factory", ".gemini", ".qwen"];
const owned: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "anima-skill-sync-")); owned.push(root);
  for (const name of names) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`);
  }
  return root;
}
const dest = (root: string, agent = ".claude", name = names[0]!) => join(root, agent, "skills", name, "SKILL.md");
function snapshot(root: string): string {
  const walk = (p: string): unknown => lstatSync(p).isDirectory()
    ? Object.fromEntries(readdirSync(p).sort().map(n => [n, walk(join(p, n))]))
    : lstatSync(p).isSymbolicLink() ? "symlink" : { bytes: readFileSync(p, "utf8"), inode: lstatSync(p).ino, modified: lstatSync(p).mtimeMs };
  return JSON.stringify(walk(root));
}
afterEach(() => { for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("OpenSpec skill copy regression", () => {
  test("SK-1: generates 24 regular byte-identical copies and is idempotent", () => {
    const root = fixture(); syncSkills(root);
    for (const agent of agents) for (const name of names) {
      const path = dest(root, agent, name);
      expect(lstatSync(path).isFile()).toBe(true);
      expect(readFileSync(path)).toEqual(readFileSync(join(root, "skills", name, "SKILL.md")));
    }
    const before = snapshot(root); syncSkills(root); syncSkills(root, { check: true });
    expect(snapshot(root)).toBe(before);
  });
  test("SK-2: check reports missing/stale copies and writes nothing", () => {
    const root = fixture(), before = snapshot(root);
    expect(() => syncSkills(root, { check: true })).toThrow(/missing|stale/i);
    expect(snapshot(root)).toBe(before);
    syncSkills(root); writeFileSync(join(root, "skills", names[0]!, "SKILL.md"), "new source");
    const stale = snapshot(root);
    expect(() => syncSkills(root, { check: true })).toThrow(/missing|stale/i);
    expect(snapshot(root)).toBe(stale);
  });
  test("SK-3: updates owned old copies and restores missing ones", () => {
    const root = fixture(); syncSkills(root);
    writeFileSync(join(root, "skills", names[0]!, "SKILL.md"), "new source");
    rmSync(dest(root, ".codex")); syncSkills(root);
    for (const agent of agents) expect(readFileSync(dest(root, agent), "utf8")).toBe("new source");
    syncSkills(root, { check: true });
  });
  test("SK-4: dirty last target refuses entire batch before replacing earlier copies", () => {
    const root = fixture(); syncSkills(root);
    writeFileSync(join(root, "skills", names[0]!, "SKILL.md"), "new source");
    writeFileSync(dest(root, ".qwen"), "user edit"); const before = snapshot(root);
    expect(() => syncSkills(root)).toThrow(/edited|unmanaged/i);
    expect(snapshot(root)).toBe(before);
  });
  test("SK-5: unmanaged conflicting copy is preserved; identical existing copies can be adopted", () => {
    const root = fixture(), path = dest(root); mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "user edit"); const before = snapshot(root);
    expect(() => syncSkills(root)).toThrow(/edited|unmanaged/i); expect(snapshot(root)).toBe(before);
    writeFileSync(path, readFileSync(join(root, "skills", names[0]!, "SKILL.md")));
    syncSkills(root); syncSkills(root, { check: true });
  });
  test("SK-6: malformed manifest refuses without writes", () => {
    const root = fixture(); syncSkills(root);
    const installed = JSON.parse(readFileSync(join(root, ".qwen/skills/.openspec-sync.json"), "utf8"));
    for (const bad of ["{", JSON.stringify({ ...installed, version: 2 }), '{"version":1,"hashes":{"oops":"x"}}']) {
      writeFileSync(join(root, ".qwen/skills/.openspec-sync.json"), bad); const before = snapshot(root);
      expect(() => syncSkills(root)).toThrow(/manifest/i); expect(snapshot(root)).toBe(before);
    }
  });
  test("SK-7: forbidden symlink source, target and parent are refused", () => {
    for (const part of ["source", "target", "parent"]) {
      const root = fixture(), outside = fixture(); syncSkills(root);
      const path = part === "source" ? join(root, "skills", names[0]!, "SKILL.md") : part === "target" ? dest(root) : join(root, ".claude");
      rmSync(path, { recursive: true }); symlinkSync(part === "parent" ? outside : join(outside, "skills", names[0]!, "SKILL.md"), path);
      const before = snapshot(root), external = snapshot(outside);
      expect(() => syncSkills(root)).toThrow(/symlink/i); expect(snapshot(root)).toBe(before); expect(snapshot(outside)).toBe(external);
    }
  });
  test("SK-8: unknown canonical assets and missing source fail before writes", () => {
    const root = fixture(); writeFileSync(join(root, "skills", names[3]!, "asset.txt"), "do not omit");
    const before = snapshot(root); expect(() => syncSkills(root)).toThrow(/single|unexpected|SKILL.md/i); expect(snapshot(root)).toBe(before);
    rmSync(join(root, "skills", names[3]!, "asset.txt")); rmSync(join(root, "skills", names[3]!, "SKILL.md"));
    const missing = snapshot(root); expect(() => syncSkills(root)).toThrow(); expect(snapshot(root)).toBe(missing);
  });
  test("SK-9: preserves unrelated agent skills and ordinary files", () => {
    const root = fixture(); mkdirSync(join(root, ".claude/skills/custom"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/custom/SKILL.md"), "custom"); syncSkills(root);
    expect(readFileSync(join(root, ".claude/skills/custom/SKILL.md"), "utf8")).toBe("custom");
  });
  test("SK-10 regression: Finder metadata does not block sync or check and is never copied", () => {
    const root = fixture();
    for (const name of names) writeFileSync(join(root, "skills", name, ".DS_Store"), "fixture metadata");
    expect(syncSkills(root)).toEqual({ copies: 24 });
    const before = snapshot(root);
    syncSkills(root, { check: true }); syncSkills(root);
    expect(snapshot(root)).toBe(before);
    for (const agent of agents) for (const name of names) {
      expect(readdirSync(join(root, agent, "skills", name))).toEqual(["SKILL.md"]);
      expect(readFileSync(join(root, agent, "skills", name, "SKILL.md")))
        .toEqual(readFileSync(join(root, "skills", name, "SKILL.md")));
    }
  });
  test("SK-11 security: metadata exception rejects symlinks, directories and other hidden assets before writes", () => {
    for (const kind of ["symlink", "directory", "other-hidden"]) {
      const root = fixture(), outside = fixture(); syncSkills(root);
      const metadata = join(root, "skills", names[0]!, ".DS_Store");
      if (kind === "symlink") symlinkSync(join(outside, "skills", names[0]!, "SKILL.md"), metadata);
      else if (kind === "directory") mkdirSync(metadata);
      else writeFileSync(join(root, "skills", names[0]!, ".hidden-asset"), "must not omit");
      const before = snapshot(root), external = snapshot(outside);
      expect(() => syncSkills(root)).toThrow(kind === "other-hidden" ? /unexpected canonical assets/ : /symlink|Expected file/);
      expect(snapshot(root)).toBe(before); expect(snapshot(outside)).toBe(external);
    }
  });
});
