import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CartridgeRegistry, validateEntry } from "../../src/cartridge/registry";

export function makeRoots() {
  const base = mkdtempSync(join(tmpdir(), "cart-"));
  return {
    colonyRoot: join(base, "agora"),
    globalRoot: join(base, "anima-global"),
    projectRoot: join(base, "project"),
  };
}

export function writeCartridge(root: string, sub: string, file: string, frontmatter: string, body: string) {
  const dir = join(root, "cartridges", sub);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `---\n${frontmatter}\n---\n\n${body}\n`);
}

export function writeSkill(root: string, name: string, body: string) {
  const dir = join(root, "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ntype: skill\nname: ${name}\ncategory: craft\n---\n\n${body}\n`);
}

test("SC-001 valid cartridge parses with content", async () => {
  const roots = makeRoots();
  writeCartridge(roots.projectRoot, "shared", "programming.md",
    "type: cartridge\nname: programming\ncategory: craft", "Engineering mode.");
  const registry = new CartridgeRegistry(roots);
  const entry = (await registry.list("tester")).find((e) => e.name === "programming");
  expect(entry).toBeDefined();
  expect(entry!.category).toBe("craft");
  expect(entry!.content).toBe("Engineering mode.");
});

test("SC-002 missing name is skipped without throwing", async () => {
  const roots = makeRoots();
  writeCartridge(roots.projectRoot, "shared", "broken.md", "type: cartridge\ncategory: craft", "Body.");
  const registry = new CartridgeRegistry(roots);
  const entries = await registry.list("tester");
  expect(entries.length).toBe(0);
});

test("SC-003 budget_tokens and memory policy parsed", async () => {
  const roots = makeRoots();
  writeCartridge(roots.projectRoot, "shared", "prog.md",
    "type: cartridge\nname: prog\ncategory: craft\nbudget_tokens: 4000\nmemory:\n  write_scopes: [scent, scar, decision]",
    "Body.");
  const registry = new CartridgeRegistry(roots);
  const entry = (await registry.list("tester")).find((e) => e.name === "prog");
  expect(entry!.budgetTokens).toBe(4000);
  expect(entry!.memory!.writeScopes).toEqual(["scent", "scar", "decision"]);
});

test("IR-04 cartridge parses its declared canonical substrate scopes", async () => {
  const roots = makeRoots();
  writeCartridge(roots.projectRoot, "shared", "runtime-aware.md",
    "type: cartridge\nname: runtime-aware\ncategory: craft\nretrieval:\n  substrate_scopes: [project_history, current_state]",
    "Body.");
  const registry = new CartridgeRegistry(roots);
  const entry = (await registry.list("tester")).find((e) => e.name === "runtime-aware");

  expect(entry!.retrieval!.substrate_scopes).toEqual(["project_history", "current_state"]);
  expect(entry!.retrieval!.scopes).toBeUndefined();
});

test("SC-041a cartridge declaring locked scopes is flagged invalid", async () => {
  const roots = makeRoots();
  writeCartridge(roots.projectRoot, "shared", "evil.md",
    "type: cartridge\nname: evil\ncategory: craft\nmemory:\n  write_scopes: [identity, scar]",
    "Body.");
  const registry = new CartridgeRegistry(roots);
  const entry = (await registry.list("tester")).find((e) => e.name === "evil");
  const errors = validateEntry(entry!);
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("identity");
});

test("SC-004 colony tier discovered", async () => {
  const roots = makeRoots();
  writeCartridge(roots.colonyRoot, "shared", "marketing.md",
    "type: cartridge\nname: marketing\ncategory: create", "Marketing mode.");
  const registry = new CartridgeRegistry(roots);
  const entry = (await registry.list("tester")).find((e) => e.name === "marketing");
  expect(entry).toBeDefined();
  expect(entry!.scope).toBe("shared");
  expect(entry!.path.startsWith(roots.colonyRoot)).toBe(true);
});

test("SC-005 project tier overrides colony tier", async () => {
  const roots = makeRoots();
  writeCartridge(roots.colonyRoot, "shared", "programming.md",
    "type: cartridge\nname: programming\ncategory: craft", "Colony version.");
  writeCartridge(roots.projectRoot, "shared", "programming.md",
    "type: cartridge\nname: programming\ncategory: craft", "Project version.");
  const registry = new CartridgeRegistry(roots);
  const matches = (await registry.list("tester")).filter((e) => e.name === "programming");
  expect(matches.length).toBe(1);
  expect(matches[0].content).toBe("Project version.");
});

test("SC-006 missing colony dir tolerated", async () => {
  const roots = makeRoots();
  writeCartridge(roots.projectRoot, "shared", "prog.md",
    "type: cartridge\nname: prog\ncategory: craft", "Body.");
  const registry = new CartridgeRegistry({ ...roots, colonyRoot: join(roots.colonyRoot, "does-not-exist") });
  const entries = await registry.list("tester");
  expect(entries.length).toBe(1);
});

test("SC-007 within budget", async () => {
  const roots = makeRoots();
  writeCartridge(roots.projectRoot, "shared", "small.md",
    "type: cartridge\nname: small\ncategory: craft\nbudget_tokens: 5000", "x".repeat(15200));
  const registry = new CartridgeRegistry(roots);
  const entry = (await registry.list("tester")).find((e) => e.name === "small")!;
  const check = await registry.budgetCheck(entry);
  expect(check.over).toBe(false);
  expect(check.estimate).toBe(3800);
  expect(check.budget).toBe(5000);
});

test("SC-008a over default budget flagged", async () => {
  const roots = makeRoots();
  writeCartridge(roots.projectRoot, "shared", "big.md",
    "type: cartridge\nname: big\ncategory: craft", "x".repeat(28800));
  const registry = new CartridgeRegistry(roots);
  const entry = (await registry.list("tester")).find((e) => e.name === "big")!;
  const check = await registry.budgetCheck(entry);
  expect(check.over).toBe(true);
  expect(check.estimate).toBe(7200);
  expect(check.budget).toBe(5000);
});

test("SC-009 skills inlined in declared order before body", async () => {
  const roots = makeRoots();
  writeSkill(roots.projectRoot, "qa-code", "QA CODE SKILL");
  writeSkill(roots.projectRoot, "qa-architecture", "QA ARCH SKILL");
  writeCartridge(roots.projectRoot, "shared", "prog.md",
    "type: cartridge\nname: prog\ncategory: craft\nskills:\n  - qa-code\n  - qa-architecture", "BODY");
  const registry = new CartridgeRegistry(roots);
  const entry = (await registry.list("tester")).find((e) => e.name === "prog")!;
  const expanded = await registry.expand(entry);
  const iCode = expanded.indexOf("QA CODE SKILL");
  const iArch = expanded.indexOf("QA ARCH SKILL");
  const iBody = expanded.indexOf("BODY");
  expect(iCode).toBeGreaterThanOrEqual(0);
  expect(iCode).toBeLessThan(iArch);
  expect(iArch).toBeLessThan(iBody);
  expect(expanded).toContain("---");
});

test("SC-010 missing skill skipped with warning", async () => {
  const roots = makeRoots();
  writeSkill(roots.projectRoot, "qa-code", "QA CODE SKILL");
  writeCartridge(roots.projectRoot, "shared", "prog.md",
    "type: cartridge\nname: prog\ncategory: craft\nskills:\n  - qa-code\n  - nonexistent", "BODY");
  const registry = new CartridgeRegistry(roots);
  const entry = (await registry.list("tester")).find((e) => e.name === "prog")!;
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: unknown) => { warnings.push(String(msg)); };
  const expanded = await registry.expand(entry);
  console.warn = original;
  expect(expanded).toContain("QA CODE SKILL");
  expect(expanded).toContain("BODY");
  expect(warnings.some((w) => w.includes("nonexistent"))).toBe(true);
});
