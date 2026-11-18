import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real dispatch/adapter subprocesses, synthetic tools and records. No live Hive or neural graph acceptance.
function processFixture(query: string, sources: string[], mode = "normal") {
  const root = mkdtempSync(join(tmpdir(), "bruno-recall-process-"));
  const trace = join(root, "calls.jsonl");
  try {
    const hive = join(root, "agora/hive/bin/hive");
    const bruno = join(root, "work/bruno-entity/scripts/recall.mjs");
    mkdirSync(join(root, "agora/hive/bin"), { recursive: true });
    mkdirSync(join(root, "work/bruno-entity/scripts"), { recursive: true });
    const record = `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv.slice(2))+'\\n');`;
    if (mode !== "missing-hive") writeFileSync(hive, `#!${process.execPath}\n${record}\nif (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(["search", "--", query]))}) process.exit(9); console.log('Concept\\tSynthetic Hive hit');`, { mode: 0o700 });
    writeFileSync(bruno, `${record}\nif (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(["--query", query, "--topK", "5"]))}) process.exit(9); console.log(${JSON.stringify(mode === "malformed-bruno" ? "not-json" : JSON.stringify({ query, confidence: "high", neurons: [{ id: "fixture-neuron", content: "Synthetic Bruno hit", type: "observation", activation: 0.9 }], recalledIds: ["fixture-neuron"] }))});`);
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/recall-process.ts"), mode === "wrong-root" ? join(root, "other") : root, query, ...sources], {
      env: { PATH: process.env.PATH ?? "", HOME: root, ANIMA_HOME: root, ANIMA_COST_DB: ":memory:", NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe", timeout: 10000,
    });
    const stdout = new TextDecoder().decode(child.stdout), stderr = new TextDecoder().decode(child.stderr);
    const calls = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    return { exit: child.exitCode, stdout, stderr, calls };
  } finally { rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false); }
}

import { recall, LLMQueryClassifier, HeuristicQueryClassifier, JevQueryClassifier, defaultClassifier, type QueryClassifier, type RecallSource } from "../src/recall-dispatcher";

function fakeRouter(reply: string) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async query() {
      calls += 1;
      return { message: { role: "assistant" as const, content: reply } };
    },
  };
}

class FakeClassifier implements QueryClassifier {
  constructor(private readonly sources: RecallSource[]) {}
  async classify(): Promise<RecallSource[]> {
    return this.sources;
  }
}

describe("recall", () => {
  test("a colony/agent-info query dispatches to real hive search", async () => {
    const child = processFixture("recall", ["hive"]);
    expect(child.exit).toBe(0);
    expect(child.calls).toEqual([["search", "--", "recall"]]);
    const results = JSON.parse(child.stdout);
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("hive");
    // Synthetic executable, reached through the actual default Hive process path.
    expect(results[0].content).toBe("Concept\tSynthetic Hive hit\n");
  });

  test("a self/history query dispatches to real BrunoEntityAdapter.recall()", async () => {
    const child = processFixture("test", ["bruno_entity"]);
    expect(child.exit).toBe(0);
    expect(child.calls).toEqual([["--query", "test", "--topK", "5"]]);
    const results = JSON.parse(child.stdout);
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("bruno_entity");
    // Real adapter parses synthetic script output; no operator neural graph is read.
    expect(results[0].content).toBe("Synthetic Bruno hit");
  });

  test("an ambiguous query dispatches to all matching sources, not one", async () => {
    const child = processFixture("hive colony session", ["hive", "bruno_entity"]);
    expect(child.exit).toBe(0);
    expect(child.calls).toEqual([["search", "--", "hive colony session"], ["--query", "hive colony session", "--topK", "5"]]);
    const results = JSON.parse(child.stdout) as Array<{ source: string; content: string }>;
    expect(results.map((r) => r.content)).toEqual(["Concept\tSynthetic Hive hit\n", "Synthetic Bruno hit"]);
    const sources = results.map((r) => r.source).sort();
    expect(sources).toEqual(["bruno_entity", "hive"]);
  });

  test("a RAG-shaped query returns a clear not-yet-implemented result, not silence or a crash", async () => {
    const results = await recall("search the wiki for X", { classifier: new FakeClassifier(["rag"]) });
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("rag");
    expect(results[0].content.toLowerCase()).toContain("not yet implemented");
  });

  test("an empty classification produces an empty result, not an error", async () => {
    const results = await recall("gibberish query matching nothing", { classifier: new FakeClassifier([]) });
    expect(results).toEqual([]);
  });
});

function countingClassifier(sources: RecallSource[]) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async classify(): Promise<RecallSource[]> {
      calls += 1;
      return sources;
    },
  };
}

describe("HeuristicQueryClassifier (SC-076: skip the LLM for unambiguous queries)", () => {
  test("a query naming another colony agent resolves to hive without calling the fallback", async () => {
    const fallback = countingClassifier(["bruno_entity"]);
    const classifier = new HeuristicQueryClassifier(fallback);
    const sources = await classifier.classify("what has eli been working on lately?");
    expect(sources).toEqual(["hive"]);
    expect(fallback.calls).toBe(0);
  });

  test("a query naming the hive itself resolves to hive without calling the fallback", async () => {
    const fallback = countingClassifier([]);
    const classifier = new HeuristicQueryClassifier(fallback);
    const sources = await classifier.classify("search the hive for that");
    expect(sources).toEqual(["hive"]);
    expect(fallback.calls).toBe(0);
  });

  test("a query mentioning wiki resolves to rag without calling the fallback", async () => {
    const fallback = countingClassifier([]);
    const classifier = new HeuristicQueryClassifier(fallback);
    const sources = await classifier.classify("search the wiki for X");
    expect(sources).toEqual(["rag"]);
    expect(fallback.calls).toBe(0);
  });

  test("a query with no heuristic signal falls through to the fallback classifier", async () => {
    const fallback = countingClassifier(["bruno_entity"]);
    const classifier = new HeuristicQueryClassifier(fallback);
    const sources = await classifier.classify("what did we decide about the compiler design earlier?");
    expect(sources).toEqual(["bruno_entity"]);
    expect(fallback.calls).toBe(1);
  });

  test("a query with signals for two heuristic categories at once is ambiguous -- falls through rather than guessing", async () => {
    const fallback = countingClassifier(["hive", "rag"]);
    const classifier = new HeuristicQueryClassifier(fallback);
    const sources = await classifier.classify("search the hive and the wiki for that");
    expect(sources).toEqual(["hive", "rag"]);
    expect(fallback.calls).toBe(1);
  });
});

describe("LLMQueryClassifier retry behavior (SC-075)", () => {
  test("a confident 'none' reply is not retried", async () => {
    const router = fakeRouter("none");
    const classifier = new LLMQueryClassifier(router, 3);
    const sources = await classifier.classify("gibberish query matching nothing");
    expect(sources).toEqual([]);
    expect(router.calls).toBe(1);
  });

  test("a valid match on the first attempt is not retried", async () => {
    const router = fakeRouter("hive");
    const classifier = new LLMQueryClassifier(router, 3);
    const sources = await classifier.classify("colony query");
    expect(sources).toEqual(["hive"]);
    expect(router.calls).toBe(1);
  });

  test("a malformed reply is retried up to the attempt limit, then gives up", async () => {
    const router = fakeRouter("this is not a valid classification response");
    const classifier = new LLMQueryClassifier(router, 3);
    const sources = await classifier.classify("some query");
    expect(sources).toEqual([]);
    expect(router.calls).toBe(3);
  });
});

// LLMQueryClassifier has no live-provider tests: defaultClassifier() no longer builds that path
// (see "defaultClassifier" describe block below); LLMQueryClassifier stays
// exported and unit-tested (SC-075 above) for callers who still want it.

function fakeJevDecide(answers: Record<string, { choice: string }> | null) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async decide(): Promise<Record<string, { choice: string }> | null> {
      calls += 1;
      return answers;
    },
  };
}

describe("JevQueryClassifier", () => {
  test("a single 'yes' answer maps to that one source", async () => {
    const decide = fakeJevDecide({ hive: { choice: "yes" }, bruno_entity: { choice: "no" }, rag: { choice: "no" } });
    const classifier = new JevQueryClassifier(decide.decide);
    const sources = await classifier.classify("what did eli decide about the memory bridge last week?");
    expect(sources).toEqual(["hive"]);
    expect(decide.calls).toBe(1);
  });

  test("multiple 'yes' answers all included", async () => {
    const decide = fakeJevDecide({ hive: { choice: "yes" }, bruno_entity: { choice: "yes" }, rag: { choice: "no" } });
    const classifier = new JevQueryClassifier(decide.decide);
    const sources = await classifier.classify("hive colony session");
    expect([...sources].sort()).toEqual(["bruno_entity", "hive"]);
  });

  test("all-'no' answers produce an empty result", async () => {
    const decide = fakeJevDecide({ hive: { choice: "no" }, bruno_entity: { choice: "no" }, rag: { choice: "no" } });
    const classifier = new JevQueryClassifier(decide.decide);
    const sources = await classifier.classify("what's the weather today");
    expect(sources).toEqual([]);
  });

  test("a failed decide call (network/auth error) fails open to an empty result, not a throw", async () => {
    const classifier = new JevQueryClassifier(async () => null);
    const sources = await classifier.classify("some query");
    expect(sources).toEqual([]);
  });
});

// Paid TypeSafe tests are opt-in: JEV_LIVE_TESTS=1 with TYPESAFE_API_KEY.
// Ordinary test runs never dispatch a paid model call.
describe.skipIf(Bun.env.JEV_LIVE_TESTS !== "1" || !Bun.env.TYPESAFE_API_KEY)("JevQueryClassifier (real provider call, jev-1.13.0 via TypeSafe System One)", () => {
  test("a colony/agent query classifies to hive", async () => {
    const classifier = new JevQueryClassifier();
    const sources = await classifier.classify("what did eli decide about the memory bridge last week?");
    expect(sources).toContain("hive");
  }, 15_000);

  test("a self-referential query classifies to bruno_entity", async () => {
    const classifier = new JevQueryClassifier();
    const sources = await classifier.classify("what did I (Bruno) decide about the identity runtime scope?");
    expect(sources).toContain("bruno_entity");
  }, 15_000);

  test("a doc/wiki search query classifies to rag", async () => {
    const classifier = new JevQueryClassifier();
    const sources = await classifier.classify("search the wiki for the deployment steps");
    expect(sources).toContain("rag");
  }, 15_000);

  test("an unrelated query classifies to nothing", async () => {
    const classifier = new JevQueryClassifier();
    const sources = await classifier.classify("what's the weather today");
    expect(sources).toEqual([]);
  }, 15_000);
});

describe.skipIf(Bun.env.JEV_LIVE_TESTS !== "1" || !Bun.env.TYPESAFE_API_KEY)("defaultClassifier (now wires Jev behind the SC-076 heuristic pre-filter)", () => {
  test("an indirect, non-literal query still resolves to bruno_entity, not just keyword match", async () => {
    const classifier = await defaultClassifier();
    const sources = await classifier.classify(
      "what did I (Bruno) decide about the compiler design earlier in this thread?",
    );
    expect(sources).toContain("bruno_entity");
  }, 15_000);

  test("a literal colony/hive query resolves to hive via the heuristic, no network call needed", async () => {
    const classifier = await defaultClassifier();
    const sources = await classifier.classify("search the colony lexicon for information about the hive");
    expect(sources).toContain("hive");
  }, 15_000);
});

test("forbidden recall fixture root refuses before any tool runs", () => {
  const child = processFixture("q", ["hive"], "wrong-root");
  expect(child.exit).toBe(1); expect(child.stderr).toContain("fixture root forbidden before imports");
  expect(child.stdout).toBe(""); expect(child.calls).toEqual([]);
});
test("missing Hive fixture is an explicit child failure, not operator fallback", () => {
  const child = processFixture("q", ["hive"], "missing-hive");
  expect(child.exit).toBe(1); expect(child.stdout).toBe(""); expect(child.calls).toEqual([]);
  expect(child.stderr).toContain("ENOENT");
  expect(child.stderr).toContain("agora/hive/bin/hive");
});
test("malformed synthetic neural output gives the real adapter's empty result", () => {
  const child = processFixture("q", ["bruno_entity"], "malformed-bruno");
  expect(child.exit).toBe(0); expect(child.calls).toEqual([["--query", "q", "--topK", "5"]]);
  expect(JSON.parse(child.stdout)).toEqual([{ source: "bruno_entity", content: "" }]);
});

test("recall subprocess excludes a parent environment canary", () => {
  const previous = process.env.RECALL_FIXTURE_CANARY;
  try {
    process.env.RECALL_FIXTURE_CANARY = "synthetic-parent-marker";
    const child = processFixture("q", ["hive"]);
    expect(child.exit).toBe(0);
    expect(child.calls).toEqual([["search", "--", "q"]]);
  } finally {
    if (previous === undefined) delete process.env.RECALL_FIXTURE_CANARY;
    else process.env.RECALL_FIXTURE_CANARY = previous;
  }
});

test("regression: cold HOME source dispatch preserves literal query arguments", () => {
  const query = 'fixture "quoted" --literal $(not-a-command)';
  const child = processFixture(query, ["hive", "bruno_entity"]);
  expect(child.exit).toBe(0);
  expect(child.calls).toEqual([["search", "--", query], ["--query", query, "--topK", "5"]]);
  expect(JSON.parse(child.stdout)).toEqual([
    { source: "hive", content: "Concept\tSynthetic Hive hit\n" },
    { source: "bruno_entity", content: "Synthetic Bruno hit" },
  ]);
});

test("leading-dash query refuses Hive dispatch and preserves the adapter's literal argv", () => {
  const query = "--topK 99";
  const child = processFixture(query, ["hive", "bruno_entity"]);
  expect(child.exit).toBe(0);
  expect(child.calls).toEqual([["--query", query, "--topK", "5"]]);
  expect(JSON.parse(child.stdout)).toEqual([
    { source: "hive", content: "" },
    { source: "bruno_entity", content: "Synthetic Bruno hit" },
  ]);
});
