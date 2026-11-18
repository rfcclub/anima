import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCartridge } from "../../adapters/oc/cartridge-loader.mjs";

function makeDirs() {
  const base = mkdtempSync(join(tmpdir(), "oc-cart-"));
  const colonyRoot = join(base, "agora");
  const localDir = join(base, "agent-local");
  mkdirSync(join(colonyRoot, "cartridges", "shared"), { recursive: true });
  mkdirSync(localDir, { recursive: true });
  return { colonyRoot, localDir };
}

function file(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

test("SC-060 OC loads colony cartridge", () => {
  const { colonyRoot, localDir } = makeDirs();
  writeFileSync(join(colonyRoot, "cartridges", "shared", "programming.md"),
    file("type: cartridge\nname: programming\ncategory: craft", "COLONY PROG"));
  const result = loadCartridge("programming", { colonyRoot, localDir });
  expect(result?.content).toBe("COLONY PROG");
});

test("SC-061 agent-local overrides colony", () => {
  const { colonyRoot, localDir } = makeDirs();
  writeFileSync(join(colonyRoot, "cartridges", "shared", "programming.md"),
    file("type: cartridge\nname: programming\ncategory: craft", "COLONY PROG"));
  writeFileSync(join(localDir, "programming.md"),
    file("type: cartridge\nname: programming\ncategory: craft", "LOCAL PROG"));
  const result = loadCartridge("programming", { colonyRoot, localDir });
  expect(result?.content).toBe("LOCAL PROG");
});

test("SC-064 unknown frontmatter fields ignored", () => {
  const { colonyRoot, localDir } = makeDirs();
  writeFileSync(join(colonyRoot, "cartridges", "shared", "prog.md"),
    file("type: cartridge\nname: prog\ncategory: craft\nanima_only_hint: xyz", "BODY"));
  const result = loadCartridge("prog", { colonyRoot, localDir });
  expect(result?.content).toBe("BODY");
  expect(result?.name).toBe("prog");
});
