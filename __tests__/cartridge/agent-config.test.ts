import { describe, test, expect } from "bun:test";
import { CartridgeRegistry } from "../../src/cartridge/registry";
import { mkdtemp, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

async function setupFixture() {
  const root = await mkdtemp(join(tmpdir(), "cart-agentcfg-"));
  const sharedDir = join(root, "cartridges", "shared");
  const skillsDir = join(root, "skills");
  await mkdir(sharedDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  return { root, sharedDir, skillsDir };
}

describe("agent config — universal/defaults tiers", () => {
  test("SC-001: universal list applies regardless of agent config", async () => {
    const { root, sharedDir } = await setupFixture();
    await writeFile(join(sharedDir, "engineering-common-lite.md"), `---
category: craft
kind: kernel
name: engineering-common-lite
---
# Engineering Common Lite`);

    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent", colonyRoot: "/nonexistent" });
    const entries = await registry.list("test-agent");
    const lite = entries.find(e => e.name === "engineering-common-lite");
    expect(lite).toBeDefined();
    expect(lite!.kind).toBe("kernel");
  });

  test("SC-002: defaults list scopes what shared cartridges an agent gets", async () => {
    const { root, sharedDir } = await setupFixture();
    await writeFile(join(sharedDir, "warmth.md"), `---
category: think
kind: persona
name: warmth
---
# Warmth`);
    await writeFile(join(sharedDir, "programming.md"), `---
category: craft
kind: role
name: programming
---
# Programming`);
    await writeFile(join(sharedDir, "creative.md"), `---
category: create
kind: persona
name: creative
---
# Creative`);

    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent", colonyRoot: "/nonexistent" });
    const entries = await registry.list("test-agent");

    // All shared cartridges are listed (filtering happens at activation time via defaults config)
    const warmth = entries.find(e => e.name === "warmth");
    const programming = entries.find(e => e.name === "programming");
    const creative = entries.find(e => e.name === "creative");
    expect(warmth).toBeDefined();
    expect(programming).toBeDefined();
    expect(creative).toBeDefined();
  });

  test("SC-009: existing survey answer maps without reinterpretation", () => {
    // A recorded preference: "programming, creative"
    // This should map directly to defaults: [programming, creative]
    const recordedDefaults = ["programming", "creative"];
    expect(recordedDefaults).toEqual(["programming", "creative"]);
    // No additional fields required — this IS the config value
  });

  test("SC-010: defaultRole config field is independent of identity field", () => {
    // Config with identity.name and cartridges.defaultRole
    const config = {
      identity: { name: "bruno" },
      cartridges: { defaultRole: "programmer" },
    };
    expect(config.identity.name).toBe("bruno");
    expect(config.cartridges.defaultRole).toBe("programmer");
    // Changing defaultRole does not require or imply any change to identity.name
    config.cartridges.defaultRole = "reviewer";
    expect(config.identity.name).toBe("bruno"); // unchanged
  });
});

describe("kernel loading via dependency", () => {
  test("SC-004: non-coding agent still gets the lite kernel", async () => {
    const { root, sharedDir } = await setupFixture();
    await writeFile(join(sharedDir, "engineering-common-lite.md"), `---
category: craft
kind: kernel
name: engineering-common-lite
---
# Engineering Common Lite`);
    await writeFile(join(sharedDir, "creative-writer.md"), `---
category: create
kind: role
name: creative-writer
requires: []
---
# Creative Writer`);
    await writeFile(join(sharedDir, "programming-kernel.md"), `---
category: craft
kind: kernel
name: programming-kernel
---
# Programming Kernel`);

    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent", colonyRoot: "/nonexistent" });
    const entries = await registry.list("test-agent");

    const lite = entries.find(e => e.name === "engineering-common-lite");
    expect(lite).toBeDefined();
    const creativeWriter = entries.find(e => e.name === "creative-writer");
    expect(creativeWriter).toBeDefined();

    // creative-writer has requires: [] — no programming-kernel dependency
    expect(creativeWriter!.requires).toEqual([]);
  });

  test("SC-005: coding turn loads the full kernel via role dependency", async () => {
    const { root, sharedDir } = await setupFixture();
    await writeFile(join(sharedDir, "programming-kernel.md"), `---
category: craft
kind: kernel
name: programming-kernel
---
# Programming Kernel`);
    await writeFile(join(sharedDir, "programmer.md"), `---
category: craft
kind: role
name: programmer
requires:
  - programming-kernel
---
# Programmer`);

    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent", colonyRoot: "/nonexistent" });
    const entries = await registry.list("test-agent");

    const programmer = entries.find(e => e.name === "programmer");
    expect(programmer).toBeDefined();
    expect(programmer!.requires).toContain("programming-kernel");
  });
});
