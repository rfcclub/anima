import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decideQueryChoices } from "../src/jev-choice.ts";
import { createDirectRecallPolicy, HeuristicQueryClassifier, JevQueryClassifier } from "../src/bruno-recall-policy.ts";
import { JevQueryClassifier as LegacyClassifier } from "../../bruno-runtime/src/recall-dispatcher.ts";

const questions = { route: { type: "choice" as const, instructions: "Select a route", criteria: { yes: "matches", no: "does not match" } } };
const answer = { type: "choice", choice: "yes", confidence: 0.8, probabilities: { yes: 0.9, no: 0.1 } };

test("JC-01 typesafe wire contract sends only query and static questions", async () => {
  let calls = 0;
  const result = await decideQueryChoices("synthetic query", questions, { apiKey: "test-key", fetcher: async (url, init) => {
    calls++;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ model: "jev-1.13.0", state: "synthetic query", questions });
    return Response.json({ answers: { route: answer } });
  } });
  expect(result?.route.choice).toBe("yes");
  expect(result?.route.probabilities.yes).toBe(0.9);
  expect(calls).toBe(1);
});

test("JC-02 missing key and invalid input never dispatch", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({}); };
  for (const query of ["", " ", "x".repeat(4097)]) expect(await decideQueryChoices(query, questions, { apiKey: "key", fetcher })).toBeNull();
  expect(await decideQueryChoices("query", questions, { apiKey: "", fetcher })).toBeNull();
  expect(calls).toBe(0);
});

test("JC-02 malformed responses and provider errors fail open without retry", async () => {
  for (const payload of [null, {}, { answers: {} }, { answers: { route: null } },
    ...[{ choice: "maybe" }, { type: "noul" }, { confidence: 2 }, { probabilities: { yes: 0.9 } }, { probabilities: { yes: -1, no: 2 } }, { probabilities: { yes: 0.1, no: 0.1 } }].map(patch => ({ answers: { route: { ...answer, ...patch } } }))]) {
    let calls = 0;
    expect(await decideQueryChoices("query", questions, { apiKey: "key", fetcher: async () => { calls++; return Response.json(payload); } })).toBeNull();
    expect(calls).toBe(1);
  }
  for (const fetcher of [async () => new Response("secret", { status: 429 }), async () => new Response("not json"), async () => { throw new Error("SECRET"); }]) {
    expect(await decideQueryChoices("query", questions, { apiKey: "key", fetcher })).toBeNull();
  }
});

test("JC-02 timeout covers a hung response body", async () => {
  let aborted = false;
  const started = performance.now();
  const result = await decideQueryChoices("query", questions, { apiKey: "key", timeoutMs: 10, fetcher: async (_url, init) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; });
    return new Response(new ReadableStream({ start() {} }));
  } });
  expect(result).toBeNull();
  expect(aborted).toBe(true);
  expect(performance.now() - started).toBeLessThan(500);
});

test("JC-03 injected rejection fails open and preserves direct Bruno recall", async () => {
  const classifier = new JevQueryClassifier(async () => { throw new Error("SECRET"); });
  expect(await classifier.classify("query")).toEqual([]);
  const policy = createDirectRecallPolicy({ classifier, dispatchers: { bruno_entity: async () => ({ source: "bruno_entity", content: "PRIVATE MEMORY" }) } });
  expect(await policy.recall("query")).toEqual([{ source: "bruno_entity", content: "PRIVATE MEMORY" }]);
  expect(await new HeuristicQueryClassifier(classifier).classify("colony")).toEqual(["hive"]);
});

test("JC-04 credential convention and compatibility path", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  expect(main).toContain('["TYPESAFE_API_KEY"]');
  expect(main).not.toContain("OPENROUTER_API_KEY");
  expect(LegacyClassifier).toBe(JevQueryClassifier);
});

test("JC-01 default classifier uses TypeSafe and never includes recalled memory", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.TYPESAFE_API_KEY;
  const bodies: unknown[] = [];
  process.env.TYPESAFE_API_KEY = "synthetic-key";
  globalThis.fetch = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ answers: { hive: { ...answer, choice: "no" }, bruno_entity: answer, rag: { ...answer, choice: "no" } } });
  }, { preconnect: previousFetch.preconnect });
  try {
    const policy = createDirectRecallPolicy({ classifier: new JevQueryClassifier(), dispatchers: { bruno_entity: async () => ({ source: "bruno_entity", content: "PRIVATE SUBSTRATE" }) } });
    expect(await policy.recall("synthetic query")).toEqual([{ source: "bruno_entity", content: "PRIVATE SUBSTRATE" }]);
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(bodies)).not.toContain("PRIVATE SUBSTRATE");
    expect((bodies[0] as { state: string }).state).toBe("synthetic query");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  }
});
