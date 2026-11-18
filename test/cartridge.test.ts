import { describe, expect, it } from "bun:test";
import { CartridgeLoader, type CartridgeTriggerContext } from "../src/cartridge/loader";
import { CartridgeRegistry } from "../src/cartridge/registry";
import { join } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("CartridgeLoader", () => {
  const loader = new CartridgeLoader();

  it("should return category based on mode trigger", () => {
    expect(loader.resolve({ mode: "edit", message: "hi" })).toBe("craft");
    expect(loader.resolve({ mode: "plan", message: "hi" })).toBe("think");
    expect(loader.resolve({ mode: "auto", message: "hi" })).toBe("operate");
  });

  it("should match task patterns", () => {
    const ctx: CartridgeTriggerContext = {
      mode: "plan",
      message: "can you debug this for me?",
      taskPatterns: {
        craft: ["debug", "fix"],
        operate: ["deploy"],
      },
    };
    expect(loader.resolve(ctx)).toBe("craft");
  });

  it("should prioritize selfSelect trigger", () => {
    const ctx: CartridgeTriggerContext = {
      mode: "edit", // normally craft
      message: "debug", // normally craft
      selfSelect: "philosophy", // actually "think" since selfSelect config is used
      taskPatterns: {
        craft: ["debug"],
      },
    };
    // wait, our loader checks if selfSelect is a category directly.
    // Let's assume the config specifies category name "think"
    ctx.selfSelect = "think";
    expect(loader.resolve(ctx)).toBe("think");
  });
});

describe("CartridgeRegistry", () => {
  const agentName = "test-agent";

  it("should scan agent and shared cartridges", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "cart-test-"));
    const agentDir = join(testRoot, "rooms", agentName, "cartridges");
    const sharedDir = join(testRoot, "cartridges", "shared");

    await mkdir(agentDir, { recursive: true });
    await mkdir(sharedDir, { recursive: true });

    await writeFile(join(agentDir, "agent-craft.md"), `---\ncategory: craft\nname: programming\n---\n# Agent Craft`);
    await writeFile(join(sharedDir, "shared-think.md"), `---\ncategory: think\nname: philosophy\n---\n# Shared Think`);

    const registry = new CartridgeRegistry({ projectRoot: testRoot, globalRoot: "/nonexistent", colonyRoot: "/nonexistent" });
    const entries = await registry.list(agentName);

    expect(entries.length).toBe(2);

    const programming = entries.find(e => e.name === "programming");
    expect(programming).toBeDefined();
    expect(programming?.category).toBe("craft");
    expect(programming?.scope).toBe("agent");

    const philosophy = entries.find(e => e.name === "philosophy");
    expect(philosophy).toBeDefined();
    expect(philosophy?.category).toBe("think");
    expect(philosophy?.scope).toBe("shared");

    await rm(testRoot, { recursive: true, force: true });
  });
});
