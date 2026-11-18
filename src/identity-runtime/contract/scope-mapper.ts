import type { MemoryScope } from "../../memory/contract.ts";
import {
  CANONICAL_SUBSTRATE_SCOPES,
  type CanonicalSubstrateScope,
  type IdentityRuntimeRecallResponse,
  type ScopeMappingRule,
  type ScopeResolution,
} from "./types.ts";

export {
  CANONICAL_SUBSTRATE_SCOPES,
  type CanonicalSubstrateScope,
  type IdentityRuntimeRecallRequest,
  type IdentityRuntimeRecallResponse,
  type ScopeDiagnostic,
  type ScopeResolution,
} from "./types.ts";

/**
 * Explicit, reviewed conversion from the substrate-map vocabulary to the
 * persisted-memory vocabulary. It is intentionally not inferred from names.
 */
export const SUBSTRATE_SCOPE_MEMORY_SCOPES: Record<CanonicalSubstrateScope, readonly MemoryScope[]> = {
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
};

const DEFAULT_RULES: readonly ScopeMappingRule[] = CANONICAL_SUBSTRATE_SCOPES.map((substrateScope) => ({
  substrateScope,
  memoryScopes: SUBSTRATE_SCOPE_MEMORY_SCOPES[substrateScope],
}));

export function isCanonicalSubstrateScope(scope: string): scope is CanonicalSubstrateScope {
  return (CANONICAL_SUBSTRATE_SCOPES as readonly string[]).includes(scope);
}

/**
 * Converts only declared canonical substrate scopes. A malformed registry is
 * treated as ambiguous rather than selecting a plausible mapping.
 */
export class ScopeMapper {
  private readonly mappings = new Map<string, readonly MemoryScope[] | null>();

  constructor(rules: readonly ScopeMappingRule[] = DEFAULT_RULES) {
    for (const rule of rules) {
      const existing = this.mappings.get(rule.substrateScope);
      this.mappings.set(rule.substrateScope, existing === undefined ? rule.memoryScopes : null);
    }
  }

  resolve(requestedScope: string, declaredScopes: readonly CanonicalSubstrateScope[]): ScopeResolution {
    if (!isCanonicalSubstrateScope(requestedScope)) {
      return {
        ok: false,
        requestedScope,
        diagnostic: {
          code: "unknown_scope",
          message: `Unknown canonical substrate scope: "${requestedScope}".`,
        },
      };
    }

    if (!declaredScopes.includes(requestedScope)) {
      return {
        ok: false,
        requestedScope,
        diagnostic: {
          code: "undeclared_scope",
          message: `Scope "${requestedScope}" is not declared by this cartridge.`,
        },
      };
    }

    const memoryScopes = this.mappings.get(requestedScope);
    if (memoryScopes === null || memoryScopes === undefined) {
      return {
        ok: false,
        requestedScope,
        diagnostic: {
          code: "ambiguous_scope",
          message: `Scope "${requestedScope}" has multiple canonical mappings.`,
        },
      };
    }

    return { ok: true, requestedScope, memoryScopes };
  }

  /**
   * The sole recall dispatch helper for this boundary. It makes rejected scope
   * resolution mechanically incapable of reaching the supplied recall port.
   */
  async recall<T>(
    requestedScope: string,
    declaredScopes: readonly CanonicalSubstrateScope[],
    recall: (memoryScopes: readonly MemoryScope[]) => Promise<readonly T[]>,
  ): Promise<IdentityRuntimeRecallResponse<T>> {
    const resolution = this.resolve(requestedScope, declaredScopes);
    if (!resolution.ok) return { resolution, results: [] };

    return { resolution, results: await recall(resolution.memoryScopes) };
  }
}
