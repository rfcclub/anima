import type { AgentMemoryEntry } from "../../../src/memory/contract.ts";

/**
 * Provenance tagging for every remember that passes through the shared
 * identity-runtime (not just external hosts): if another client injects memory
 * the agent does not have, it should be clearly tagged external, not the
 * agent's own. Every write already has a real clientId and surfaceId at this
 * boundary; tagging them is unconditional and cheap, and doesn't require
 * solving the harder "which client is the trusted owner" question, which is
 * deliberately not addressed here.
 */
export function tagProvenance(
  entry: Omit<AgentMemoryEntry, "id" | "createdAt">,
  source: { clientId: string; surfaceId: string },
): Omit<AgentMemoryEntry, "id" | "createdAt"> {
  return {
    ...entry,
    tags: [...(entry.tags ?? []), `source-client:${source.clientId}`, `source-surface:${source.surfaceId}`],
    metadata: {
      ...(entry.metadata ?? {}),
      sourceClientId: source.clientId,
      sourceSurfaceId: source.surfaceId,
    },
  };
}
