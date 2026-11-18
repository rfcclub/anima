import { describe, test, expect } from "bun:test";
import { CartridgeRegistry } from "../../src/cartridge/registry";
import { mkdtemp, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

async function setupFixture() {
  const root = await mkdtemp(join(tmpdir(), "cart-schema-"));
  const sharedDir = join(root, "cartridges", "shared");
  const agentDir = join(root, "rooms", "test-agent", "cartridges");
  await mkdir(sharedDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  return { root, sharedDir, agentDir };
}

describe("cartridge schema — kind field", () => {
  test("SC-007: cartridge with kind field is accepted", async () => {
    const { root, sharedDir } = await setupFixture();
    await writeFile(join(sharedDir, "programming.md"), `---
category: craft
kind: role
name: programming
---
# Programming`);

    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent", colonyRoot: "/nonexistent" });
    const entries = await registry.list("test-agent");
    const programming = entries.find(e => e.name === "programming");
    expect(programming).toBeDefined();
    expect(programming!.kind).toBe("role");
  });

  test("SC-007: cartridge without kind field is still accepted during migration window", async () => {
    const { root, sharedDir } = await setupFixture();
    await writeFile(join(sharedDir, "legacy.md"), `---
category: craft
name: legacy
---
# Legacy`);

    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent", colonyRoot: "/nonexistent" });
    const entries = await registry.list("test-agent");
    const legacy = entries.find(e => e.name === "legacy");
    expect(legacy).toBeDefined();
    expect(legacy!.kind).toBeUndefined(); // no kind = accepted but undefined
  });
});

describe("cartridge schema — guides/rules split", () => {
  test("SC-001: guides and rules both expand into prompt content", async () => {
    const { root, sharedDir } = await setupFixture();
    const skillsDir = join(root, "skills");
    await mkdir(skillsDir, { recursive: true });

    await writeFile(join(skillsDir, "programming-kernel.md"), `---
name: programming-kernel
type: skill
---
# Programming Kernel — guides content`);
    await writeFile(join(skillsDir, "qa-code.md"), `---
name: qa-code
type: skill
---
# QA Code — rules content`);

    await writeFile(join(sharedDir, "programming.md"), `---
category: craft
kind: role
name: programming
guides: [programming-kernel]
rules: [qa-code]
---
# Programming`);

    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent", colonyRoot: "/nonexistent" });
    const entries = await registry.list("test-agent");
    const programming = entries.find(e => e.name === "programming");
    expect(programming).toBeDefined();
    // expand() should inline both guides and rules
    const expanded = await registry.expand(programming!);
    expect(expanded).toContain("Programming Kernel");
    expect(expanded).toContain("QA Code");
  });

  test("SC-002: legacy flat skills array still resolves during migration", async () => {
    const { root, sharedDir } = await setupFixture();
    const skillsDir = join(root, "skills");
    await mkdir(skillsDir, { recursive: true });

    await writeFile(join(skillsDir, "qa-code.md"), `---
name: qa-code
type: skill
---
# QA Code`);

    await writeFile(join(sharedDir, "legacy.md"), `---
category: craft
kind: role
name: legacy
skills: [qa-code]
---
# Legacy`);

    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent", colonyRoot: "/nonexistent" });
    const entries = await registry.list("test-agent");
    const legacy = entries.find(e => e.name === "legacy");
    expect(legacy).toBeDefined();
    const expanded = await registry.expand(legacy!);
    expect(expanded).toContain("QA Code");
  });
});

describe("cartridge schema — skill/cartridge separation", () => {
  test("SC-008: skills/ directory is not scanned as cartridges", async () => {
    const { root, sharedDir } = await setupFixture();
    const skillsDir = join(root, "skills");
    await mkdir(skillsDir, { recursive: true });

    // Put a cartridge in shared
    await writeFile(join(sharedDir, "programming.md"), `---
category: craft
kind: role
name: programming
---
# Programming`);

    // Put a skill in skills/ — should be ignored for cartridge listing
    await writeFile(join(skillsDir, "qa-code.md"), `---
name: qa-code
---
# QA Code`);

    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent", colonyRoot: "/nonexistent" });
    const entries = await registry.list("test-agent");
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("programming");
    expect(entries.some(e => e.name === "qa-code")).toBe(false);
  });
});

describe("cartridge schema — persona block", () => {
  test("SC-009: optional persona block included in expansion", async () => {
    const { root, sharedDir } = await setupFixture();
    await writeFile(join(sharedDir, "programmer.md"), `---
category: craft
kind: role
name: programmer
persona: |
  Speak concisely. No filler.
---
# Programmer`);

    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent", colonyRoot: "/nonexistent" });
    const entries = await registry.list("test-agent");
    const programmer = entries.find(e => e.name === "programmer");
    expect(programmer).toBeDefined();
    const expanded = await registry.expand(programmer!);
    expect(expanded).toContain("Speak concisely");
  });

  test("SC-010: absent persona block is a no-op", async () => {
    const { root, sharedDir } = await setupFixture();
    await writeFile(join(sharedDir, "programmer.md"), `---
category: craft
kind: role
name: programmer
---
# Programmer`);

    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent", colonyRoot: "/nonexistent" });
    const entries = await registry.list("test-agent");
    const programmer = entries.find(e => e.name === "programmer");
    expect(programmer).toBeDefined();
    const expanded = await registry.expand(programmer!);
    // Should still contain the main content
    expect(expanded).toContain("Programmer");
    // No persona content
    expect(expanded).not.toContain("persona:");
  });
});
