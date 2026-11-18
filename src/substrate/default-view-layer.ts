import type { SubstrateAdapter, RetrievalRequest, RetrievalResult, SubstrateSource } from "./substrate-adapter";
import {
  type AgentDefaults,
  type BuildViewParams,
  type CartridgeRetrievalPolicy,
  type FallbackAction,
  type ResolvedCartridgeRetrieval,
  type ScopeFallback,
  type SubstrateView,
  type SubstrateViewLayer,
  type SubstrateViewWarning,
  type TurnContext,
  RUNTIME_REQUIRED_SCOPES,
} from "./substrate-view";
import { estimateTokens } from "../utils/tokens";

/**
 * Default SubstrateViewLayer implementation.
 *
 * Builds a SubstrateView by:
 * 1. Collecting runtime-required scopes + agent defaults + cartridge policies.
 * 2. Resolving and retrieving files for each scope through the adapter.
 * 3. Applying cartridge fallback actions when scopes are missing/empty.
 *
 * Does NOT format for the prompt — that is the PromptAssembler's job.
 */
export class DefaultSubstrateViewLayer implements SubstrateViewLayer {
  async buildView(params: BuildViewParams): Promise<SubstrateView> {
    const { cartridgePolicies, agentDefaults, adapter, query, maxTokens } = params;

    const runtimeRequiredScopes = [...RUNTIME_REQUIRED_SCOPES];
    const agentDefaultScopes = agentDefaults.defaultScopes ?? [];

    // Build unified scope request set
    const requestedScopes = new Set<string>([
      ...runtimeRequiredScopes,
      ...agentDefaultScopes,
    ]);

    const warnings: SubstrateViewWarning[] = [];
    const resolvedPolicies: ResolvedCartridgeRetrieval[] = [];

    for (const policy of cartridgePolicies) {
      resolvedPolicies.push(policy);
      for (const scope of policy.scopesIncluded) {
        requestedScopes.add(scope);
      }
      for (const scope of policy.scopesMissing) {
        const fallback = policy.fallbackActions[scope];
        if (fallback && fallback !== "continue") {
          warnings.push({
            scope,
            code: "cartridge_scope_missing",
            message: `Cartridge ${policy.cartridgeId} requested scope "${scope}" but it is not available`,
            action: fallback,
          });
        }
      }
    }

    const turnContext: TurnContext = {
      agentId: agentDefaults.agentId,
      runtimeRequiredScopes,
      agentDefaults,
      cartridgePolicies: resolvedPolicies,
      unifiedScopes: [...requestedScopes],
      requireEvidence: cartridgePolicies.some((p) =>
        Object.values(p.scopesIncluded ?? {}).some(() => false)
      ),
      maxTokens,
      query,
    };

    // Retrieve
    const retrievalRequest: RetrievalRequest = {
      scopes: [...requestedScopes],
      query,
      maxTokens,
    };

    const results = await adapter.retrieve(retrievalRequest);

    const scopesCovered = new Set<string>();
    const scopesMissing: string[] = [];
    const scopesEmpty: string[] = [];

    for (const scope of requestedScopes) {
      const hasMatch = results.some(
        (r) =>
          r.scopesMatched.includes(scope) &&
          (r.status === "ok" || r.status === "empty" || r.status === "unsupported_source")
      );
      const hasContent = results.some(
        (r) => r.scopesMatched.includes(scope) && r.status === "ok" && r.content.length > 0
      );

      if (!hasMatch) {
        scopesMissing.push(scope);
        const required = runtimeRequiredScopes.includes(scope as (typeof RUNTIME_REQUIRED_SCOPES)[number]) || adapter.listScopes().find((s) => s.name === scope)?.required;
        if (required) {
          warnings.push({
            scope,
            code: "required_scope_missing",
            message: `Required scope "${scope}" is missing from substrate`,
            action: "block",
          });
        }
      } else if (!hasContent) {
        scopesEmpty.push(scope);
      } else {
        scopesCovered.add(scope);
      }
    }

    const estimatedTokens = results
      .filter((r) => r.status === "ok")
      .reduce((sum, r) => sum + estimateTokens(r.content), 0);

    return {
      turnContext,
      results,
      estimatedTokens,
      scopesCovered: [...scopesCovered],
      scopesMissing,
      scopesEmpty,
      warnings,
    };
  }
}
