import { describe, test, expect } from "bun:test";
import { CartridgeLoader } from "../../src/cartridge/loader";
import { CartridgeRegistry, estimateTokens } from "../../src/cartridge/registry";
import { resolveExecutionPlan } from "../../src/cartridge/activation";
import type { CartridgeEntry } from "../../src/cartridge/registry";
import type { CartridgeKind, ExecutionPlan } from "../../src/cartridge/types";
import { mkdtemp, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

function makeEntry(overrides: Partial<CartridgeEntry> & { name: string; kind: CartridgeKind }): CartridgeEntry {
  return {
    category: "craft",
    path: `/test/${overrides.name}.md`,
    content: `# ${overrides.name} content`,
    scope: "shared",
    type: "cartridge",
    ...overrides,
  };
}

async function setupFixture() {
  const root = await mkdtemp(join(tmpdir(), "cart-actv2-"));
  const sharedDir = join(root, "cartridges", "shared");
  await mkdir(sharedDir, { recursive: true });
  return { root, sharedDir };
}

describe("ExecutionPlan resolution", () => {
  test("Task 6.6: defaults [warmth, programming] compose the expected plan for coding and greeting", async () => {
    const { root } = await setupFixture();
    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent" });
    const loader = new CartridgeLoader();
    const entries = [
      makeEntry({ name: "warmth", kind: "persona" }),
      makeEntry({ name: "programmer", kind: "role" }),
      makeEntry({ name: "programming", kind: "role", triggers: { task: ["code", "fix"] } }),
    ];
    const config = {
      mode: "edit" as const,
      identity: "bruno",
      defaultRole: "programmer",
      defaults: ["warmth", "programming"],
      budgetTokens: 10_000,
    };

    const coding = await resolveExecutionPlan(registry, loader, entries, {
      ...config,
      message: "fix this code",
    });
    const greeting = await resolveExecutionPlan(registry, loader, entries, {
      ...config,
      message: "hello there",
    });

    expect(coding.interactionPersona?.name).toBe("warmth");
    expect(coding.workingRole?.name).toBe("programming");
    expect(greeting.interactionPersona?.name).toBe("warmth");
    expect(greeting.workingRole?.name).toBe("programmer");
  });

  test("SC-007: realistic multi-layer turn", async () => {
    const { root } = await setupFixture();
    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent" });
    const loader = new CartridgeLoader();

    const entries = [
      makeEntry({ name: "engineering-common-lite", kind: "kernel" }),
      makeEntry({ name: "warmth", kind: "persona" }),
      makeEntry({ name: "programmer", kind: "role", triggers: { task: ["fix", "code"] }, requires: ["programming-kernel"] }),
      makeEntry({ name: "programming-kernel", kind: "kernel" }),
      makeEntry({ name: "typescript", kind: "language", triggers: { task: ["typescript"] } }),
      makeEntry({ name: "postgres", kind: "framework", triggers: { task: ["postgres"] } }),
      makeEntry({ name: "anima", kind: "project" }),
    ];

    const plan = await resolveExecutionPlan(registry, loader, entries, {
      mode: "edit",
      message: "fix the failing test in the postgres query builder typescript",
      identity: "bruno",
      defaultRole: "programmer",
      universal: ["engineering-common-lite"],
      budgetTokens: 20000,
    });

    expect(plan.identity).toBe("bruno");
    expect(plan.workingRole?.name).toBe("programmer");
    expect(plan.dependencies.length).toBeGreaterThan(0);
    expect(plan.dependencies.some(d => d.name === "programming-kernel")).toBe(true);
    expect(plan.language?.name).toBe("typescript");
    expect(plan.framework?.name).toBe("postgres");
    expect(plan.universal.some(u => u.name === "engineering-common-lite")).toBe(true);
  });

  test("SC-008: identity-baseline kernel always present", async () => {
    const { root } = await setupFixture();
    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent" });
    const loader = new CartridgeLoader();

    const entries = [
      makeEntry({ name: "engineering-common-lite", kind: "kernel" }),
    ];

    const plan = await resolveExecutionPlan(registry, loader, entries, {
      mode: "edit",
      message: "hello",
      identity: "bruno",
      universal: ["engineering-common-lite"],
      budgetTokens: 10000,
    });

    expect(plan.universal.some(u => u.name === "engineering-common-lite")).toBe(true);
  });

  test("SC-009: total budget exceeded drops lowest-scoring layer first", async () => {
    const { root } = await setupFixture();
    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent" });
    const loader = new CartridgeLoader();

    // Create a big cartridge that will exceed budget
    const bigContent = "x".repeat(50000); // ~12500 tokens

    const entries = [
      makeEntry({ name: "engineering-common-lite", kind: "kernel" }),
      makeEntry({ name: "programmer", kind: "role", requires: [] }),
      makeEntry({ name: "typescript", kind: "language", triggers: { task: ["typescript"] } }),
      makeEntry({ name: "big-project", kind: "project", content: bigContent }),
    ];

    const plan = await resolveExecutionPlan(registry, loader, entries, {
      mode: "edit",
      message: "fix typescript code",
      identity: "bruno",
      defaultRole: "programmer",
      universal: ["engineering-common-lite"],
      budgetTokens: 5000, // tight budget
    });

    // Budget should be within limit after dropping
    expect(plan.budget.estimated).toBeLessThanOrEqual(plan.budget.limit);
    // The big-project should have been dropped
    expect(plan.project).toBeUndefined();
  });

  test("SC-011: declared conflict resolved to one winner", async () => {
    const { root } = await setupFixture();
    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent" });
    const loader = new CartridgeLoader();

    // Both programmer and reviewer match the trigger "fix" and "review"
    // programmer declares conflicts: [reviewer]
    const entries = [
      makeEntry({ name: "engineering-common-lite", kind: "kernel" }),
      makeEntry({ name: "programmer", kind: "role", conflicts: ["reviewer"], triggers: { task: ["fix", "code"] } }),
      makeEntry({ name: "reviewer", kind: "role", conflicts: ["programmer"], triggers: { task: ["review", "fix"] } }),
    ];

    // "fix" matches both, but programmer has conflicts: [reviewer]
    // So reviewer should be excluded from role layer
    const roleResult = loader.resolveLayer("role", entries, {
      mode: "edit",
      message: "fix this code review",
    });

    // Programmer should win (it's first by score, and conflicts exclude reviewer)
    expect(roleResult.length).toBeGreaterThan(0);
    expect(roleResult[0].entry.name).toBe("programmer");
    // Reviewer should be excluded due to conflict
    expect(roleResult.find(c => c.entry.name === "reviewer")).toBeUndefined();
  });

  test("SC-019: execution plan contains all resolved fields", async () => {
    const { root } = await setupFixture();
    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent" });
    const loader = new CartridgeLoader();

    const entries = [
      makeEntry({ name: "engineering-common-lite", kind: "kernel" }),
      makeEntry({ name: "reviewer", kind: "role", triggers: { task: ["review"] }, requires: ["programming-kernel", "qa-review-common"] }),
      makeEntry({ name: "programming-kernel", kind: "kernel" }),
      makeEntry({ name: "qa-review-common", kind: "kernel" }),
      makeEntry({ name: "typescript", kind: "language", triggers: { task: ["typescript"] } }),
      makeEntry({ name: "anima", kind: "project" }),
    ];

    const plan = await resolveExecutionPlan(registry, loader, entries, {
      mode: "edit",
      message: "review the typescript code",
      identity: "bruno",
      defaultRole: "programmer",
      universal: ["engineering-common-lite"],
      budgetTokens: 20000,
    });

    expect(plan.identity).toBe("bruno");
    expect(plan.workingRole?.name).toBe("reviewer");
    expect(plan.dependencies.some(d => d.name === "programming-kernel")).toBe(true);
    expect(plan.dependencies.some(d => d.name === "qa-review-common")).toBe(true);
    expect(plan.language?.name).toBe("typescript");
    expect(plan.budget.estimated).toBeGreaterThan(0);
    expect(plan.budget.limit).toBe(20000);
    expect(plan.events.length).toBeGreaterThan(0);
  });

  test("SC-020: execution plan is inspectable independent of prompt text", async () => {
    const { root } = await setupFixture();
    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent" });
    const loader = new CartridgeLoader();

    const entries = [
      makeEntry({ name: "engineering-common-lite", kind: "kernel" }),
      makeEntry({ name: "programmer", kind: "role" }),
    ];

    const plan = await resolveExecutionPlan(registry, loader, entries, {
      mode: "edit",
      message: "hello",
      identity: "bruno",
      defaultRole: "programmer",
      universal: ["engineering-common-lite"],
      budgetTokens: 10000,
    });

    // Plan is structured data, not prompt text
    expect(typeof plan.identity).toBe("string");
    expect(typeof plan.budget.estimated).toBe("number");
    expect(typeof plan.budget.limit).toBe("number");
    expect(Array.isArray(plan.dependencies)).toBe(true);
    expect(Array.isArray(plan.universal)).toBe(true);
    expect(Array.isArray(plan.events)).toBe(true);
  });

  test("SC-021: companion persona coexists with non-conversational working role", async () => {
    const { root } = await setupFixture();
    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent" });
    const loader = new CartridgeLoader();

    const entries = [
      makeEntry({ name: "engineering-common-lite", kind: "kernel" }),
      makeEntry({ name: "warmth", kind: "persona" }),
      makeEntry({ name: "architect", kind: "role", triggers: { task: ["architect"] } }),
    ];

    const plan = await resolveExecutionPlan(registry, loader, entries, {
      mode: "edit",
      message: "architect this system",
      identity: "bruno",
      defaultRole: "programmer",
      universal: ["engineering-common-lite"],
      budgetTokens: 10000,
    });

    expect(plan.interactionPersona?.name).toBe("warmth");
    expect(plan.workingRole?.name).toBe("architect");
    // Both coexist
  });

  test("fix-1: cross-layer conflict — persona conflicts with role", async () => {
    const { root } = await setupFixture();
    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent" });
    const loader = new CartridgeLoader();

    const entries = [
      makeEntry({ name: "engineering-common-lite", kind: "kernel" }),
      makeEntry({ name: "formal", kind: "persona", conflicts: ["architect"], priority: 5 }),
      makeEntry({ name: "architect", kind: "role", triggers: { task: ["architect"] }, priority: 2 }),
    ];

    const plan = await resolveExecutionPlan(registry, loader, entries, {
      mode: "edit",
      message: "architect this system",
      identity: "bruno",
      defaultRole: "programmer",
      universal: ["engineering-common-lite"],
      budgetTokens: 10000,
    });

    // formal conflicts with architect, formal has higher priority → architect dropped
    expect(plan.interactionPersona?.name).toBe("formal");
    expect(plan.workingRole).toBeUndefined(); // architect was dropped
    expect(plan.events.some(e => e.type === "cartridge_conflict")).toBe(true);
  });
});
