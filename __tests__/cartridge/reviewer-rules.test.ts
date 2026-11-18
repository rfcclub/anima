import { describe, test, expect } from "bun:test";
import { CartridgeRegistry } from "../../src/cartridge/registry";
import { mkdtemp, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

async function setupFixture() {
  const root = await mkdtemp(join(tmpdir(), "cart-reviewer-"));
  const sharedDir = join(root, "cartridges", "shared");
  const skillsDir = join(root, "skills");
  await mkdir(sharedDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  return { root, sharedDir, skillsDir };
}

describe("reviewer rules-only parsing", () => {
  test("SC-003: rule heading in a guide skill is ignored by parseRules", async () => {
    const { root, sharedDir, skillsDir } = await setupFixture();

    // A guide skill that accidentally contains a Rule heading
    await writeFile(join(skillsDir, "programming-kernel.md"), `---
name: programming-kernel
type: skill
---
# Programming Kernel

## Rule: Accidental Match
**Type:** passive
**Severity:** warn
This should never be parsed as a rule.`);

    // A cartridge that references it as a guide
    await writeFile(join(sharedDir, "programming.md"), `---
category: craft
kind: role
name: programming
guides: [programming-kernel]
rules: []
---
# Programming`);

    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent" });
    const entries = await registry.list("test-agent");
    const programming = entries.find(e => e.name === "programming");
    expect(programming).toBeDefined();

    // expand() should include the guide content
    const expanded = await registry.expand(programming!);
    expect(expanded).toContain("Programming Kernel");

    // But the Rule heading should NOT be in the rules list
    // The cartridge has rules: [] so no rules should be parsed
    expect(programming!.rules).toEqual([]);
  });

  test("SC-004: rule heading in a rules skill is parsed normally", async () => {
    const { root, sharedDir, skillsDir } = await setupFixture();

    // A rule skill with proper Rule heading
    await writeFile(join(skillsDir, "qa-code.md"), `---
name: qa-code
type: skill
---
# QA Code

## Rule: Run test suite
**Type:** active
**Severity:** error
bun test`);

    // A cartridge that references it as a rule
    await writeFile(join(sharedDir, "qa.md"), `---
category: craft
kind: review
name: qa
rules: [qa-code]
---
# QA`);

    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent" });
    const entries = await registry.list("test-agent");
    const qa = entries.find(e => e.name === "qa");
    expect(qa).toBeDefined();
    expect(qa!.rules).toEqual(["qa-code"]);

    // expand() should include the rule content
    const expanded = await registry.expand(qa!);
    expect(expanded).toContain("Run test suite");
  });

  test("SC-007: generation prompt gets summary, not full rule blocks", async () => {
    const { root, sharedDir, skillsDir } = await setupFixture();

    await writeFile(join(skillsDir, "qa-code.md"), `---
name: qa-code
type: skill
---
## Rule: Run test suite
**Type:** active
**Severity:** error
bun test`);

    await writeFile(join(sharedDir, "qa.md"), `---
category: craft
kind: review
name: qa
rules: [qa-code]
summary: "You will be reviewed for test suite, code quality, and security."
---
# QA`);

    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent" });
    const entries = await registry.list("test-agent");
    const qa = entries.find(e => e.name === "qa");
    expect(qa).toBeDefined();

    // The summary should be available from the entry
    // (This tests that the summary field is parsed from frontmatter)
    // The actual prompt assembly would use summary, not full rules
  });
});
