import type { RetrievedMemory, SubstrateRetrievalPlan } from "./types";

export interface RetrievalResult {
  memories: RetrievedMemory[];
  contextStarved: boolean;
  events: Array<Record<string, unknown> & { type: string }>;
}

export interface MemoryAdapter {
  recall(message: string, options: Record<string, unknown>): Promise<Array<{
    id: string;
    content: string;
    scope: string;
    confidence: number;
    score?: number;
    provenance?: string;
  }>>;
}

/** Merge and deduplicate memories by id, merging requested_by lists. */
export function mergeAndDedupe(memories: RetrievedMemory[]): RetrievedMemory[] {
  const byId = new Map<string, RetrievedMemory>();

  for (const mem of memories) {
    const existing = byId.get(mem.id);
    if (existing) {
      // Merge requested_by lists
      for (const name of mem.requested_by) {
        if (!existing.requested_by.includes(name)) {
          existing.requested_by.push(name);
        }
      }
      // Keep higher confidence
      if (mem.confidence > existing.confidence) {
        existing.confidence = mem.confidence;
        existing.score = mem.score;
      }
    } else {
      byId.set(mem.id, { ...mem });
    }
  }

  const merged = [...byId.values()];

  // Rank by score descending, then confidence descending
  merged.sort((a, b) => b.score - a.score || b.confidence - a.confidence);

  return merged;
}

/** Split memories into Trusted and Unverified sections. */
export function splitTrustedUnverified(
  memories: RetrievedMemory[],
  requireEvidence: boolean,
  allowUnverifiedFallback: boolean,
): { trusted: RetrievedMemory[]; unverified: RetrievedMemory[]; contextStarved: boolean } {
  if (!requireEvidence) {
    return { trusted: memories, unverified: [], contextStarved: false };
  }

  const trusted = memories.filter(m => m.trusted);
  const untrusted = memories.filter(m => !m.trusted);

  if (trusted.length === 0 && !allowUnverifiedFallback) {
    return { trusted, unverified: [], contextStarved: true };
  }

  if (trusted.length === 0 && allowUnverifiedFallback && untrusted.length > 0) {
    return { trusted, unverified: untrusted, contextStarved: false };
  }

  return { trusted, unverified: [], contextStarved: false };
}

/** Execute a retrieval plan — call adapter.recall() per request, merge/dedupe/rank. */
export async function executeRetrievalPlan(
  plan: SubstrateRetrievalPlan | null,
  message: string,
  adapter: MemoryAdapter,
  fallbackTopK?: number,
): Promise<RetrievalResult> {
  const events: RetrievalResult["events"] = [];
  const allMemories: RetrievedMemory[] = [];

  if (!plan || plan.requests.length === 0) {
    // Legacy fallback — flat topK
    const results = await adapter.recall(message, { topK: fallbackTopK ?? 5 });
    for (const r of results) {
      allMemories.push({
        id: r.id,
        content: r.content,
        scope: r.scope as RetrievedMemory["scope"],
        confidence: r.confidence,
        provenance: r.provenance,
        score: r.score ?? r.confidence,
        requested_by: [],
        policy_id: "legacy",
        trusted: r.confidence >= 0.5,
      });
    }
    const fallbackStarved = allMemories.length === 0;
    if (fallbackStarved) {
      events.push({ type: "substrate_context_starved", trustedCount: 0 });
    }
    return { memories: allMemories, contextStarved: fallbackStarved, events };
  }

  // Per-cartridge retrieval
  for (const request of plan.requests) {
    const results = await adapter.recall(message, {
      scopes: request.scopes,
      topK: request.top_k,
    });

    for (const r of results) {
      const trusted = r.confidence >= 0.5;
      allMemories.push({
        id: r.id,
        content: r.content,
        scope: r.scope as RetrievedMemory["scope"],
        confidence: r.confidence,
        provenance: r.provenance,
        score: r.score ?? r.confidence,
        requested_by: [request.cartridgeName],
        policy_id: request.cartridgeName,
        trusted,
      });
    }
  }

  // Merge, dedupe, rank
  const merged = mergeAndDedupe(allMemories);

  // Apply require_evidence strictest-winner rule
  const requireEvidence = plan.requests.some(r => r.require_evidence);
  const allowFallback = plan.requests.some(r => r.allow_unverified_fallback);
  const { trusted, unverified, contextStarved } = splitTrustedUnverified(
    merged, requireEvidence, allowFallback,
  );

  if (contextStarved) {
    events.push({ type: "substrate_context_starved", trustedCount: 0 });
  }

  return {
    memories: [...trusted, ...unverified],
    contextStarved,
    events,
  };
}
