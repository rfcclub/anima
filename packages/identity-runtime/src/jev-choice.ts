/** Narrow query-only TypeSafe transport. Callers own questions and routing policy. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Readonly<Record<string, string>>;
}
export type ChoiceAnswers<Q extends Record<string, ChoiceQuestion>> = {
  [K in keyof Q]: {
    type: "choice";
    choice: keyof Q[K]["criteria"] & string;
    confidence: number;
    probabilities: Record<keyof Q[K]["criteria"] & string, number>;
  };
};
interface ChoiceOptions {
  apiKey?: string;
  timeoutMs?: number;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const probability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

export async function decideQueryChoices<const Q extends Record<string, ChoiceQuestion>>(
  query: string,
  questions: Q,
  options: ChoiceOptions = {},
): Promise<ChoiceAnswers<Q> | null> {
  const key = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!key?.trim() || typeof query !== "string" || !query.trim() || query.length > 4096
    || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) return null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = async (): Promise<ChoiceAnswers<Q> | null> => {
      const response = await (options.fetcher ?? fetch)("https://api.typesafe.ai/v1/systemone", {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "jev-1.13.0", state: query, questions }),
      });
      if (!response.ok) { await response.body?.cancel(); return null; }
      const payload: unknown = await response.json();
      if (!record(payload) || !record(payload.answers)) return null;
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(questions)) {
        const answer = payload.answers[id];
        const keys = Object.keys(question.criteria);
        if (!record(answer) || answer.type !== "choice" || typeof answer.choice !== "string" || !keys.includes(answer.choice)
          || !probability(answer.confidence) || !record(answer.probabilities)) return null;
        const probabilities = answer.probabilities;
        if (Object.keys(probabilities).length !== keys.length || keys.some(key => !probability(probabilities[key]))) return null;
        const values = keys.map(key => probabilities[key] as number);
        if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.001) return null;
        answers[id] = { type: "choice", choice: answer.choice, confidence: answer.confidence, probabilities };
      }
      // Every requested key, enum and numeric field was checked above.
      return answers as ChoiceAnswers<Q>;
    };
    return await Promise.race([
      request(),
      new Promise<null>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
