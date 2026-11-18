import { describe, expect, test } from "bun:test";
import {
  ScopeMapper,
  SUBSTRATE_SCOPE_MEMORY_SCOPES,
  type CanonicalSubstrateScope,
} from "../../../src/identity-runtime/contract/scope-mapper.ts";

const declaredScopes = Object.keys(SUBSTRATE_SCOPE_MEMORY_SCOPES) as CanonicalSubstrateScope[];

const expectedMappings = {
  identity_core: ["identity", "heartwood"],
  values: ["behavior", "decision", "heartwood"],
  self_model: ["identity", "preference", "growth_ring"],
  relationship: ["relationship", "private"],
  episodic_memory: ["episode", "observation"],
  scars: ["scar"],
  project_history: ["project", "decision"],
  skills: ["skill"],
  world_lore: ["narrative", "fact"],
  style_memory: ["preference", "behavior"],
  current_state: ["canopy", "growth_ring", "scent"],
  open_threads: ["canopy", "project"],
} as const;

describe("ScopeMapper (IR-04)", () => {
  test("maps every declared canonical substrate scope deterministically", () => {
    const mapper = new ScopeMapper();

    for (const scope of declaredScopes) {
      expect(mapper.resolve(scope, declaredScopes)).toEqual({
        ok: true,
        requestedScope: scope,
        memoryScopes: expectedMappings[scope],
      });
    }
  });

  test("rejects an unknown scope without converting it to an unscoped recall", () => {
    const result = new ScopeMapper().resolve("shared", declaredScopes);

    expect(result).toEqual({
      ok: false,
      requestedScope: "shared",
      diagnostic: {
        code: "unknown_scope",
        message: 'Unknown canonical substrate scope: "shared".',
      },
    });
  });

  test("rejects a valid-but-undeclared scope", () => {
    const result = new ScopeMapper().resolve("project_history", ["current_state"]);

    expect(result).toEqual({
      ok: false,
      requestedScope: "project_history",
      diagnostic: {
        code: "undeclared_scope",
        message: 'Scope "project_history" is not declared by this cartridge.',
      },
    });
  });

  test("rejects an ambiguous mapping registry", () => {
    const mapper = new ScopeMapper([
      { substrateScope: "current_state", memoryScopes: ["canopy"] },
      { substrateScope: "current_state", memoryScopes: ["scent"] },
    ]);

    expect(mapper.resolve("current_state", ["current_state"])).toEqual({
      ok: false,
      requestedScope: "current_state",
      diagnostic: {
        code: "ambiguous_scope",
        message: 'Scope "current_state" has multiple canonical mappings.',
      },
    });
  });

  test("does not call recall when scope resolution is rejected", async () => {
    const recall = async () => {
      throw new Error("recall must not run");
    };

    const result = await new ScopeMapper().recall("shared", declaredScopes, recall);

    expect(result).toEqual({
      resolution: {
        ok: false,
        requestedScope: "shared",
        diagnostic: {
          code: "unknown_scope",
          message: 'Unknown canonical substrate scope: "shared".',
        },
      },
      results: [],
    });
  });
});
