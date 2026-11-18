import { describe, expect, test } from "bun:test";
import { DROP_THRESHOLD, jevRelevance } from "./relevance-filter.ts";

const jevAnswer = (choice: "yes" | "no", pNo: number) =>
  Response.json({ answers: { relevant: { type: "choice", choice, probabilities: { yes: 1 - pNo, no: pNo }, confidence: 0.5 } } });

describe("jevRelevance", () => {
  test("asks Jev about each memory against the message and returns keep flags in order", async () => {
    const calls: any[] = [];
    const filter = jevRelevance({
      apiKey: "k",
      fetcher: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url, auth: (init?.headers as any).Authorization, body });
        return body.state.includes("about castles") ? jevAnswer("no", 0.99) : jevAnswer("yes", 0.02);
      },
    });
    const keep = await filter("how does the hook recall", ["- relevant hook note", "- about castles"]);
    expect(keep).toEqual([true, false]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(calls[0].auth).toBe("Bearer k");
    expect(calls[0].body.model).toBe("typesafe/jev-1.13");
    expect(calls[0].body.state).toContain("MESSAGE: how does the hook recall");
    expect(calls[0].body.state).toContain("MEMORY: - relevant hook note");
    expect(Object.keys(calls[0].body.questions)).toEqual(["relevant"]);
  });

  test("drops only when the answer is 'no' AND P(no) reaches the threshold", async () => {
    const answers = [jevAnswer("no", DROP_THRESHOLD), jevAnswer("no", DROP_THRESHOLD - 0.05), jevAnswer("yes", 0.3)];
    let i = 0;
    const filter = jevRelevance({ apiKey: "k", fetcher: async () => answers[i++] });
    // sequential index is fine here: each item resolves one queued response in call order
    expect(await filter("q", ["a", "b", "c"])).toEqual([false, true, true]);
  });

  test("the threshold is conservative (>= 0.8) so borderline 'no' answers are kept", () => {
    expect(DROP_THRESHOLD).toBeGreaterThanOrEqual(0.8);
  });

  test.each([
    ["a non-ok response", async () => new Response("nope", { status: 500 })],
    ["a network error", async () => { throw new Error("ECONNREFUSED"); }],
    ["a malformed body", async () => Response.json({ unexpected: true })],
  ])("keeps the memory on %s (fail-open)", async (_label, fetcher) => {
    expect(await jevRelevance({ apiKey: "k", fetcher: fetcher as any })("q", ["a"])).toEqual([true]);
  });

  test("without an API key it keeps everything and never calls out", async () => {
    let called = false;
    const filter = jevRelevance({ apiKey: undefined, fetcher: async () => { called = true; return jevAnswer("no", 1); } });
    expect(await filter("q", ["a", "b"])).toEqual([true, true]);
    expect(called).toBe(false);
  });

  test("clips a long memory before sending it", async () => {
    let state = "";
    const filter = jevRelevance({ apiKey: "k", fetcher: async (_u, init) => { state = JSON.parse(String(init?.body)).state; return jevAnswer("yes", 0); } });
    await filter("q", ["x".repeat(5000)]);
    expect(state.length).toBeLessThan(900);
  });
});
