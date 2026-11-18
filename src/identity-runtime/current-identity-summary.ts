import { produceCurrentIdentitySummary, type TieredSoul } from "../identity/engine";
import type { SubstrateAdapter } from "../substrate/substrate-adapter";

async function retrieveScope(adapter: SubstrateAdapter, scope: string): Promise<string> {
  const results = await adapter.retrieve({ scopes: [scope] });
  return results
    .filter((result) => result.status === "ok" && (result.trust === "medium" || result.trust === "high") && result.content.trim().length > 0)
    .map((result) => result.content.trim())
    .join("\n\n");
}

/**
 * Reads the identity-bearing substrate scopes used by the legacy turn pipeline.
 * Callers choose their failure policy: compiler callers propagate errors;
 * flag-off legacy composition retains its existing soft-failure wrapper.
 */
export async function buildCurrentIdentitySummary(
  adapter: SubstrateAdapter | undefined,
  tiered: TieredSoul,
  maxTokens: number,
): Promise<string | undefined> {
  if (!adapter) return undefined;
  const [scars, state, relationship] = await Promise.all([
    retrieveScope(adapter, "scars"),
    retrieveScope(adapter, "current_state"),
    retrieveScope(adapter, "relationship"),
  ]);
  return produceCurrentIdentitySummary({ soul: tiered, scars, state, relationship }, maxTokens);
}
