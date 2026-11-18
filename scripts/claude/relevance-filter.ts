/**
 * Relevance filter for recalled memories, backed by Jev (TypeSafe's decisions
 * model on OpenRouter). Jev is only a sensor here: for one (message, memory)
 * pair it returns yes/no with probabilities; THIS code decides what to do with
 * that — and is deliberately conservative, because dropping a relevant memory
 * is silent while keeping an irrelevant one only costs tokens.
 *
 * What it sees is exactly the text pasted into `state` — it cannot look inside
 * bruno-entity or Hindsight — so callers must never send sensitive memories
 * (see sensitive-terms.ts) and this module fails open on any error.
 */

/** Drop only when Jev says "no" AND P(no) is at least this. Measured on ~10 synthetic pairs: relevant memories had P(no) <= 0.32, irrelevant ones 0.76-0.99. */
export const DROP_THRESHOLD = 0.8;

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "typesafe/jev-1.13";
const ITEM_CHARS = 400;
const DEFAULT_TIMEOUT_MS = 2000;

/** keep[i] === false means "drop item i". */
export type RelevanceFilter = (query: string, items: string[]) => Promise<boolean[]>;

export interface JevRelevanceOptions {
  apiKey: string | undefined;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

const QUESTIONS = {
  relevant: {
    type: "choice",
    instructions: "Is the MEMORY useful for handling the MESSAGE?",
    criteria: { yes: "directly relevant to the message's topic", no: "unrelated or only loosely related" },
  },
};

export function jevRelevance(options: JevRelevanceOptions): RelevanceFilter {
  const fetcher = options.fetcher ?? fetch;

  async function keep(query: string, item: string): Promise<boolean> {
    try {
      const response = await fetcher(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, state: `MESSAGE: ${query}\n\nMEMORY: ${item.slice(0, ITEM_CHARS)}`, questions: QUESTIONS }),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) return true;
      const answer = ((await response.json()) as { answers?: { relevant?: { choice?: string; probabilities?: Record<string, number> } } }).answers?.relevant;
      if (!answer) return true;
      return !(answer.choice === "no" && (answer.probabilities?.no ?? 0) >= DROP_THRESHOLD);
    } catch {
      return true;
    }
  }

  return async (query, items) => {
    if (!options.apiKey) return items.map(() => true);
    return Promise.all(items.map((item) => keep(query, item)));
  };
}
