import type { SubstrateAdapter } from "../../src/substrate/substrate-adapter";
import type { SubstrateViewLayer } from "../../src/substrate/substrate-view";

/**
 * Empty substrate adapter + view layer. AnimaProjectionCompiler fails closed
 * unless an agent carries both (1dc4c20d), so identity-runtime fixtures spread
 * this onto the agent instead of each hand-rolling the pair.
 */
export function emptySubstratePair(agentId: string): {
  substrateAdapter: SubstrateAdapter;
  substrateViewLayer: SubstrateViewLayer;
} {
  return {
    substrateAdapter: {
      agentId, substrateType: "fixture", listScopes: () => [], hasScope: () => false,
      resolve: (name) => ({ name, description: "", required: false, files: [] }),
      retrieve: async () => [], validateMap: () => ({ valid: true, diagnostics: [] }),
    },
    substrateViewLayer: {
      buildView: async () => ({
        turnContext: { agentId, runtimeRequiredScopes: [], agentDefaults: { agentId }, cartridgePolicies: [], unifiedScopes: [], requireEvidence: false },
        results: [], estimatedTokens: 0, scopesCovered: [], scopesMissing: [], scopesEmpty: [], warnings: [],
      }),
    },
  };
}
