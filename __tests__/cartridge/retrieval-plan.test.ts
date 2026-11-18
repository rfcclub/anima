import { describe, test, expect } from "bun:test";
import type {
  RetrievalPolicy,
  SubstrateRetrievalPlan,
  SubstrateRetrievalRequest,
  RetrievedMemory,
  IdentitySummary,
} from "../../src/cartridge/types";
import type { MemoryScope } from "../../src/memory/contract";

describe("substrate retrieval types", () => {
  test("RetrievalPolicy has all required fields", () => {
    const policy: RetrievalPolicy = {
      scopes: ["identity", "preference"],
      top_k: 8,
      max_tokens: 2000,
      require_evidence: true,
      allow_unverified_fallback: false,
    };
    expect(policy.scopes).toEqual(["identity", "preference"]);
    expect(policy.top_k).toBe(8);
    expect(policy.max_tokens).toBe(2000);
    expect(policy.require_evidence).toBe(true);
    expect(policy.allow_unverified_fallback).toBe(false);
  });

  test("RetrievalPolicy has defaults for optional fields", () => {
    const minimal: RetrievalPolicy = {
      scopes: ["episode"],
    };
    expect(minimal.top_k).toBeUndefined();
    expect(minimal.max_tokens).toBeUndefined();
    expect(minimal.require_evidence).toBeUndefined();
    expect(minimal.allow_unverified_fallback).toBeUndefined();
  });

  test("SubstrateRetrievalRequest has all fields", () => {
    const request: SubstrateRetrievalRequest = {
      cartridgeName: "programmer",
      scopes: ["project", "episode"],
      top_k: 8,
      max_tokens: 2000,
      require_evidence: false,
      allow_unverified_fallback: false,
    };
    expect(request.cartridgeName).toBe("programmer");
    expect(request.scopes).toEqual(["project", "episode"]);
  });

  test("SubstrateRetrievalPlan has requests and budget", () => {
    const plan: SubstrateRetrievalPlan = {
      requests: [],
      fallbackTopK: 5,
      globalBudget: 5000,
    };
    expect(plan.requests).toEqual([]);
    expect(plan.fallbackTopK).toBe(5);
    expect(plan.globalBudget).toBe(5000);
  });

  test("RetrievedMemory has attribution fields", () => {
    const memory: RetrievedMemory = {
      id: "mem-1",
      content: "Some memory",
      scope: "episode",
      confidence: 0.9,
      provenance: "session-123",
      score: 0.95,
      requested_by: ["programmer", "typescript"],
      policy_id: "programmer",
      trusted: true,
    };
    expect(memory.requested_by).toEqual(["programmer", "typescript"]);
    expect(memory.trusted).toBe(true);
  });

  test("IdentitySummary has tiered fields", () => {
    const summary: IdentitySummary = {
      core: "You are honest and curious.",
      preferences: "Interested in Rust and distributed systems.",
      state: "Focused, energetic.",
      totalTokens: 150,
    };
    expect(summary.core).toBeTruthy();
    expect(summary.preferences).toBeTruthy();
    expect(summary.state).toBeTruthy();
    expect(summary.totalTokens).toBe(150);
  });

  test("IdentitySummary minimal (core only)", () => {
    const minimal: IdentitySummary = {
      core: "You are honest.",
      totalTokens: 30,
    };
    expect(minimal.preferences).toBeUndefined();
    expect(minimal.state).toBeUndefined();
  });
});

describe("retrieval plan compilation", () => {
  test("SC-001: one request per cartridge with retrieval policy", async () => {
    const { compileRetrievalPlan } = await import("../../src/cartridge/activation");
    const entries = [
      {
        name: "programmer",
        kind: "role",
        retrieval: { scopes: ["project", "episode"], top_k: 8, max_tokens: 2000 },
      },
      {
        name: "typescript",
        kind: "language",
        retrieval: { scopes: ["preference"], top_k: 5, max_tokens: 1000 },
      },
      {
        name: "warmth",
        kind: "persona",
        // no retrieval policy
      },
    ];

    const plan = compileRetrievalPlan(entries as any, 5000, 5);
    expect(plan.requests.length).toBe(2);
    expect(plan.requests[0].cartridgeName).toBe("programmer");
    expect(plan.requests[0].scopes).toEqual(["project", "episode"]);
    expect(plan.requests[1].cartridgeName).toBe("typescript");
    expect(plan.requests[1].scopes).toEqual(["preference"]);
    expect(plan.fallbackTopK).toBe(5);
    expect(plan.globalBudget).toBe(5000);
  });

  test("SC-002: un-migrated cartridge uses fallback", async () => {
    const { compileRetrievalPlan } = await import("../../src/cartridge/activation");
    const entries = [
      {
        name: "warmth",
        kind: "persona",
        // no retrieval policy
      },
    ];

    const plan = compileRetrievalPlan(entries as any, 5000, 5);
    expect(plan.requests.length).toBe(0);
    expect(plan.fallbackTopK).toBe(5);
  });

  test("a canonical substrate declaration does not issue an empty legacy recall", async () => {
    const { compileRetrievalPlan } = await import("../../src/cartridge/activation");
    const entries = [
      {
        name: "runtime-aware",
        retrieval: { substrate_scopes: ["project_history", "current_state"] },
      },
    ];

    const plan = compileRetrievalPlan(entries as any, 5000, 5);
    expect(plan.requests).toEqual([]);
    expect(plan.fallbackTopK).toBe(5);
  });

  test("all cartridges have retrieval policy", async () => {
    const { compileRetrievalPlan } = await import("../../src/cartridge/activation");
    const entries = [
      { name: "a", retrieval: { scopes: ["identity"] } },
      { name: "b", retrieval: { scopes: ["episode"] } },
    ];

    const plan = compileRetrievalPlan(entries as any, 5000, 5);
    expect(plan.requests.length).toBe(2);
    expect(plan.fallbackTopK).toBeUndefined();
  });
});

describe("CartridgeEntry retrieval field", () => {
  test("programming cartridge declares its real retrieval policy", async () => {
    const { CartridgeRegistry } = await import("../../src/cartridge/registry");
    const registry = new CartridgeRegistry({
      projectRoot: process.cwd(),
      globalRoot: "/nonexistent",
      colonyRoot: "/nonexistent",
    });
    const programming = (await registry.list("test-agent")).find((entry) => entry.name === "programming");

    expect(programming?.retrieval).toEqual({
      scopes: ["project", "episode"],
      top_k: 8,
      max_tokens: 2000,
      require_evidence: true,
      allow_unverified_fallback: false,
    });
  });

  test("retrieval field is optional on CartridgeEntry", async () => {
    const { CartridgeRegistry } = await import("../../src/cartridge/registry");
    const { mkdtemp, writeFile, mkdir } = await import("fs/promises");
    const { join } = await import("path");
    const { tmpdir } = await import("os");

    const root = await mkdtemp(join(tmpdir(), "cart-retrieval-"));
    const sharedDir = join(root, "cartridges", "shared");
    await mkdir(sharedDir, { recursive: true });

    // Cartridge with retrieval policy
    await writeFile(join(sharedDir, "programming.md"), `---
category: craft
kind: role
name: programming
retrieval:
  scopes:
    - project
    - episode
  top_k: 8
  max_tokens: 2000
  require_evidence: false
---
# Programming`);

    // Cartridge without retrieval policy
    await writeFile(join(sharedDir, "warmth.md"), `---
category: think
kind: persona
name: warmth
---
# Warmth`);

    const registry = new CartridgeRegistry({ projectRoot: root, globalRoot: "/nonexistent" });
    const entries = await registry.list("test-agent");

    const programming = entries.find(e => e.name === "programming");
    const warmth = entries.find(e => e.name === "warmth");

    expect(programming).toBeDefined();
    expect(programming!.retrieval).toBeDefined();
    expect(programming!.retrieval!.scopes).toEqual(["project", "episode"]);
    expect(programming!.retrieval!.top_k).toBe(8);

    expect(warmth).toBeDefined();
    expect(warmth!.retrieval).toBeUndefined();
  });
});
