import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runCartridgeCli } from "../../src/cartridge/cli";
import { makeRoots, writeCartridge, writeSkill } from "./registry.test";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    io: { write: (s: string) => out.push(s), error: (s: string) => err.push(s) },
  };
}

test("SC-012 validate passes clean registry with per-tier counts", async () => {
  const roots = makeRoots();
  writeCartridge(roots.projectRoot, "shared", "prog.md",
    "type: cartridge\nname: prog\ncategory: craft", "Body.");
  const { out, io } = capture();
  const code = await runCartridgeCli(["validate"], { ...roots, ...io });
  expect(code).toBe(0);
  expect(out.join("")).toContain("shared: 1");
});

test("SC-011 validate reports malformed cartridge and exits non-zero", async () => {
  const roots = makeRoots();
  const dir = join(roots.projectRoot, "cartridges", "shared");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "broken.md"), "---\ntype: cartridge\ncategory: craft\n---\n\nNo name.\n");
  const { err, io } = capture();
  const code = await runCartridgeCli(["validate"], { ...roots, ...io });
  expect(code).toBe(1);
  expect(err.join("")).toContain("broken.md");
});

test("SC-062 expand prints inlined skills + body, no frontmatter", async () => {
  const roots = makeRoots();
  writeSkill(roots.projectRoot, "qa-code", "QA SKILL");
  writeCartridge(roots.projectRoot, "shared", "prog.md",
    "type: cartridge\nname: prog\ncategory: craft\nskills:\n  - qa-code", "PROG BODY");
  const { out, io } = capture();
  const code = await runCartridgeCli(["expand", "prog"], { ...roots, ...io });
  expect(code).toBe(0);
  const text = out.join("");
  expect(text).toContain("QA SKILL");
  expect(text).toContain("PROG BODY");
  expect(text.indexOf("QA SKILL")).toBeLessThan(text.indexOf("PROG BODY"));
  expect(text).not.toContain("type: cartridge");
});

test("SC-063 expand unknown cartridge fails with named tiers", async () => {
  const roots = makeRoots();
  const { err, io } = capture();
  const code = await runCartridgeCli(["expand", "nonexistent"], { ...roots, ...io });
  expect(code).toBe(1);
  expect(err.join("")).toContain("nonexistent");
  expect(err.join("")).toContain("colony");
});
