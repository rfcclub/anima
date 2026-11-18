import { test, expect, describe } from "bun:test";
import { DefaultPromptAssembler } from "../../src/substrate/default-prompt-assembler";
import type { SubstrateView, TurnContext, AgentDefaults } from "../../src/substrate/substrate-view";
import type { RetrievalResult } from "../../src/substrate/substrate-adapter";

function makeTurnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  const agentDefaults: AgentDefaults = {
    agentId: "test-agent",
    defaultScopes: ["relationship"],
  };

  return {
    agentId: "test-agent",
    runtimeRequiredScopes: ["identity_core", "current_state"],
    agentDefaults,
    cartridgePolicies: [],
    unifiedScopes: ["identity_core", "current_state", "relationship"],
    requireEvidence: false,
    ...overrides,
  };
}

function makeResult(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    id: "test-id",
    absolutePath: "/tmp/test/soul.md",
    relativePath: "soul.md",
    content: "# Identity\nI am a test agent.",
    scopesMatched: ["identity_core"],
    sourceIds: ["identity_core:0"],
    requestedBy: [],
    trust: "high",
    weight: 1.0,
    status: "ok",
    ...overrides,
  };
}

describe("DefaultPromptAssembler", () => {
  test("assembles a simple view into blocks", () => {
    const assembler = new DefaultPromptAssembler();
    const view: SubstrateView = {
      turnContext: makeTurnContext(),
      results: [
        makeResult({ content: "# Identity\nI am Test.", scopesMatched: ["identity_core"], trust: "high", weight: 1.0 }),
      ],
      estimatedTokens: 100,
      scopesCovered: ["identity_core"],
      scopesMissing: [],
      scopesEmpty: [],
      warnings: [],
    };

    const ctx = assembler.assemble(view);
    expect(ctx.blocks.length).toBe(1);
    expect(ctx.blocks[0].scope).toBe("identity_core");
    expect(ctx.blocks[0].label).toBe("Identity");
    expect(ctx.blocks[0].content).toContain("I am Test.");
    expect(ctx.truncated).toBe(false);
  });

  test("orders blocks by trust then weight", () => {
    const assembler = new DefaultPromptAssembler();
    const view: SubstrateView = {
      turnContext: makeTurnContext(),
      results: [
        makeResult({ id: "low", scopesMatched: ["project_history"], trust: "low", weight: 0.5, content: "low" }),
        makeResult({ id: "high", scopesMatched: ["identity_core"], trust: "high", weight: 1.0, content: "high" }),
        makeResult({ id: "med", scopesMatched: ["current_state"], trust: "medium", weight: 0.8, content: "medium" }),
      ],
      estimatedTokens: 50,
      scopesCovered: ["identity_core", "current_state", "project_history"],
      scopesMissing: [],
      scopesEmpty: [],
      warnings: [],
    };

    const ctx = assembler.assemble(view);
    const order = ctx.blocks.map((b) => b.trust);
    expect(order).toEqual(["high", "medium", "low"]);
  });

  test("respects prioritizeScopes option", () => {
    const assembler = new DefaultPromptAssembler();
    const view: SubstrateView = {
      turnContext: makeTurnContext(),
      results: [
        makeResult({ id: "a", scopesMatched: ["identity_core"], trust: "high", weight: 1.0, content: "id" }),
        makeResult({ id: "b", scopesMatched: ["project_history"], trust: "medium", weight: 0.8, content: "proj" }),
      ],
      estimatedTokens: 50,
      scopesCovered: ["identity_core", "project_history"],
      scopesMissing: [],
      scopesEmpty: [],
      warnings: [],
    };

    const ctx = assembler.assemble(view, { prioritizeScopes: ["project_history"] });
    expect(ctx.blocks[0].scope).toBe("project_history");
  });

  test("truncates when over token budget", () => {
    const assembler = new DefaultPromptAssembler();
    const bigContent = "x".repeat(5000); // ~1250 tokens
    const view: SubstrateView = {
      turnContext: makeTurnContext(),
      results: [
        makeResult({ id: "a", content: bigContent, scopesMatched: ["identity_core"], trust: "high", weight: 1.0 }),
        makeResult({ id: "b", content: bigContent, scopesMatched: ["project_history"], trust: "low", weight: 0.3 }),
      ],
      estimatedTokens: 2500,
      scopesCovered: ["identity_core", "project_history"],
      scopesMissing: [],
      scopesEmpty: [],
      warnings: [],
    };

    const ctx = assembler.assemble(view, { maxTokens: 200 });
    expect(ctx.blocks.length).toBe(1);
    expect(ctx.truncated).toBe(true);
    expect(ctx.warnings.some((w) => w.includes("Truncated"))).toBe(true);
  });

  test("includes evidence when includeEvidence is true", () => {
    const assembler = new DefaultPromptAssembler();
    const view: SubstrateView = {
      turnContext: makeTurnContext(),
      results: [
        makeResult({
          scopesMatched: ["project_history"],
          trust: "medium",
          weight: 0.8,
          content: "# Design\nSome design notes.",
          evidence: { confidence: 0.9, provenance: "/tmp/test" },
        }),
      ],
      estimatedTokens: 30,
      scopesCovered: ["project_history"],
      scopesMissing: [],
      scopesEmpty: [],
      warnings: [],
    };

    const without = assembler.assemble(view, { includeEvidence: false });
    expect(without.blocks[0].content).not.toContain("confidence");

    const withEvidence = assembler.assemble(view, { includeEvidence: true });
    // evidence is on the block object, formatting is tested separately
    expect(withEvidence.blocks[0].evidence?.confidence).toBe(0.9);
  });

  test("yaml format produces yaml-shaped output", () => {
    const assembler = new DefaultPromptAssembler();
    const view: SubstrateView = {
      turnContext: makeTurnContext(),
      results: [
        makeResult({ content: "# Test\nHello.", scopesMatched: ["identity_core"], trust: "high", weight: 1.0 }),
      ],
      estimatedTokens: 20,
      scopesCovered: ["identity_core"],
      scopesMissing: [],
      scopesEmpty: [],
      warnings: [],
    };

    const ctx = assembler.assemble(view, { format: "yaml" });
    expect(ctx.blocks.length).toBe(1);
    expect(ctx.totalTokens).toBeGreaterThan(0);
  });

  test("surfaces missing and empty scope warnings", () => {
    const assembler = new DefaultPromptAssembler();
    const view: SubstrateView = {
      turnContext: makeTurnContext(),
      results: [],
      estimatedTokens: 0,
      scopesCovered: [],
      scopesMissing: ["project_history"],
      scopesEmpty: ["scars"],
      warnings: [{ scope: "project_history", code: "MISSING", message: "not found", action: "continue_with_warning" }],
    };

    const ctx = assembler.assemble(view);
    expect(ctx.warnings.length).toBeGreaterThanOrEqual(2);
    expect(ctx.warnings.some((w) => w.includes("project_history"))).toBe(true);
    expect(ctx.warnings.some((w) => w.includes("scars"))).toBe(true);
  });

  test("skips non-ok results", () => {
    const assembler = new DefaultPromptAssembler();
    const view: SubstrateView = {
      turnContext: makeTurnContext(),
      results: [
        makeResult({ id: "ok", status: "ok", content: "good" }),
        makeResult({ id: "err", status: "error", content: "bad" }),
        makeResult({ id: "empty", status: "empty", content: "" }),
        makeResult({ id: "missing", status: "missing_scope", content: "" }),
      ],
      estimatedTokens: 10,
      scopesCovered: ["identity_core"],
      scopesMissing: [],
      scopesEmpty: [],
      warnings: [],
    };

    const ctx = assembler.assemble(view);
    expect(ctx.blocks.length).toBe(1);
    expect(ctx.blocks[0].id).toBeUndefined(); // blocks don't have id
  });
});
