import type { AgentMemoryStore } from "../memory/contract";
import type { RemoteDirectRecallResult } from "./contract/remote-continuity.ts";

/** Direct (free-text) recall over an identity's own canonical store, in the runtime's `{source, content}` shape. */
export function storeDirectRecall(
  store: Pick<AgentMemoryStore, "recall">,
  source: string,
  topK = 5,
): (request: { query: string }) => Promise<RemoteDirectRecallResult> {
  return async ({ query }) => {
    const entries = await store.recall(query, { topK });
    return entries.map((entry) => ({ source, content: entry.content }));
  };
}
