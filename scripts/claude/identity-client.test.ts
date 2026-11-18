import { describe, expect, test } from "bun:test";
import { composeQuery, formatRecall, hindsightRecall, promptToQuery, runHook, type HookDeps } from "./identity-client.ts";
import { createGuard } from "./sensitive-terms.ts";

const hookJson = (out: string | undefined) => (out ? JSON.parse(out).hookSpecificOutput : undefined);

function deps(over: Partial<HookDeps> = {}): HookDeps {
  return {
    recall: async () => [],
    noteGate: { shouldNote: () => true, markNoted: () => {} },
    deadlineMs: 500,
    // Dummy terms: the real list lives outside the repository.
    guard: createGuard({ phrases: ["secret-topic"], words: [] }),
    ...over,
  };
}

describe("promptToQuery", () => {
  test("keeps a substantive prompt, collapsing whitespace", () => {
    expect(promptToQuery("what did we decide\n\nabout  the castle presence?")).toBe("what did we decide about the castle presence?");
  });

  test("clips to 300 chars", () => {
    expect(promptToQuery("word ".repeat(200))!.length).toBeLessThanOrEqual(300);
  });

  test("strips xml-ish wrappers such as a channel envelope", () => {
    const q = promptToQuery('<channel source="telegram" chat_id="1">please check the castle for bugs</channel>');
    expect(q).toBe("please check the castle for bugs");
  });

  test.each(["", "   ", "ok", "/model", "/loop 5m check the build please"])("skips trivial or slash-command prompt %p", (p) => {
    expect(promptToQuery(p)).toBeUndefined();
  });
});

describe("formatRecall", () => {
  test("renders non-empty results under their source", () => {
    const out = formatRecall([{ source: "bruno_entity", content: "a decision about X" }]);
    expect(out).toContain("bruno_entity");
    expect(out).toContain("a decision about X");
  });

  test("drops empty and '(no results)' entries; empty when nothing is left", () => {
    expect(formatRecall([{ source: "hive", content: "(no results)\n" }, { source: "rag", content: "  " }])).toBe("");
  });

  test("caps the total size", () => {
    const big = { source: "bruno_entity", content: "x".repeat(5000) };
    expect(formatRecall([big, big, big]).length).toBeLessThanOrEqual(1900);
  });
});

describe("runHook", () => {
  test("injects runtime results as UserPromptSubmit additionalContext", async () => {
    const out = hookJson(await runHook({ prompt: "what did Bruno decide about identity?" }, deps({
      recall: async () => [{ source: "bruno_entity", content: "she chose X" }],
    })));
    expect(out.hookEventName).toBe("UserPromptSubmit");
    expect(out.additionalContext).toContain("identity-runtime");
    expect(out.additionalContext).toContain("she chose X");
  });

  test("passes the cleaned query to recall", async () => {
    let seen = "";
    await runHook({ prompt: "  a  substantive   question here  " }, deps({ recall: async (q) => { seen = q; return []; } }));
    expect(seen).toBe("a substantive question here");
  });

  test("a trivial prompt makes no call and prints nothing", async () => {
    let called = false;
    const out = await runHook({ prompt: "ok" }, deps({ recall: async () => { called = true; return []; } }));
    expect(out).toBeUndefined();
    expect(called).toBe(false);
  });

  test("no results and no fallback prints nothing", async () => {
    expect(await runHook({ prompt: "a substantive question here" }, deps())).toBeUndefined();
  });

  // The runtime now asks bruno_entity itself, so an empty answer is a real "nothing":
  // the local store would only add the same loose keyword matches. Local recall is
  // for when the runtime could not answer at all (identity-runtime-federated-recall).
  test("an empty runtime answer does NOT trigger the local fallback", async () => {
    let asked = false;
    const out = await runHook({ prompt: "a substantive question here" }, deps({
      localRecall: async () => { asked = true; return "- [fact#1] from local bruno.db"; },
    }));
    expect(out).toBeUndefined();
    expect(asked).toBe(false);
  });

  test("a runtime failure falls back to local recall, labelled as fallback", async () => {
    const out = hookJson(await runHook({ prompt: "a substantive question here" }, deps({
      recall: async () => { throw new Error("connect ECONNREFUSED"); },
      localRecall: async () => "- [fact#1] from local bruno.db",
    })));
    expect(out.additionalContext).toContain("fallback");
    expect(out.additionalContext).toContain("from local bruno.db");
  });

  test("a runtime error is fail-open: one note line, plus the local fallback if any", async () => {
    const out = hookJson(await runHook({ prompt: "a substantive question here" }, deps({
      recall: async () => { throw new Error("connect ECONNREFUSED"); },
      localRecall: async () => "- [fact#1] local",
    })));
    expect(out.additionalContext).toContain("recall unavailable");
    expect(out.additionalContext).toContain("ECONNREFUSED");
    expect(out.additionalContext).toContain("- [fact#1] local");
  });

  test("the failure note is rate-limited by noteGate, and marked when emitted", async () => {
    let marked = 0;
    const failing = { recall: async () => { throw new Error("down"); } };
    const quiet = await runHook({ prompt: "a substantive question here" }, deps({ ...failing, noteGate: { shouldNote: () => false, markNoted: () => { marked++; } } }));
    expect(quiet).toBeUndefined();
    expect(marked).toBe(0);
    await runHook({ prompt: "a substantive question here" }, deps({ ...failing, noteGate: { shouldNote: () => true, markNoted: () => { marked++; } } }));
    expect(marked).toBe(1);
  });

  test("a hung runtime is cut off at the deadline and never blocks the turn", async () => {
    const t0 = Date.now();
    const out = hookJson(await runHook({ prompt: "a substantive question here" }, deps({
      recall: () => new Promise(() => {}),
      deadlineMs: 60,
    })));
    expect(Date.now() - t0).toBeLessThan(400);
    expect(out.additionalContext).toContain("timed out");
  });

  test("a throwing local fallback never breaks the hook", async () => {
    const out = await runHook({ prompt: "a substantive question here" }, deps({
      localRecall: async () => { throw new Error("recall.mjs exploded"); },
    }));
    expect(out).toBeUndefined();
  });

  test("missing prompt field prints nothing", async () => {
    expect(await runHook({}, deps())).toBeUndefined();
  });
});

describe("composeQuery", () => {
  test("a short prompt gets the project appended as context", () => {
    expect(composeQuery("please fix recall-agent.sh", "anima")).toBe("please fix recall-agent.sh (project: anima)");
  });

  test("a long prompt already carries its own context and is left alone", () => {
    const long = "what did we decide about the castle presence pulse restore last week";
    expect(composeQuery(long, "anima")).toBe(long);
  });

  test("no project, or a skipped prompt, changes nothing", () => {
    expect(composeQuery("please fix recall-agent.sh", undefined)).toBe("please fix recall-agent.sh");
    expect(composeQuery("ok", "anima")).toBeUndefined();
  });
});

describe("hindsightRecall", () => {
  const ok = (results: unknown) => async () => Response.json({ results });

  test("posts the query to the bank's recall endpoint and formats the top results", async () => {
    let seen: { url: string; body: any } | undefined;
    const text = await hindsightRecall("castle presence", {
      apiUrl: "http://localhost:8891/", bank: "coding-agent::anima",
      fetcher: async (url, init) => { seen = { url, body: JSON.parse(String(init?.body)) }; return Response.json({ results: [{ text: "fact one" }, { text: "fact two" }] }); },
    });
    expect(seen!.url).toBe("http://localhost:8891/v1/default/banks/coding-agent%3A%3Aanima/memories/recall");
    expect(seen!.body).toMatchObject({ query: "castle presence", max_tokens: 500 });
    expect(text).toContain("- fact one");
    expect(text).toContain("- fact two");
  });

  // Hindsight can require an API key: send it as a bearer token when configured, never otherwise.
  test("sends the API token as a bearer header only when one is configured", async () => {
    const seen: Array<string | null> = [];
    const fetcher = async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ results: [] });
    };
    await hindsightRecall("q", { apiUrl: "http://h", bank: "b", fetcher, apiToken: "secret-token" });
    await hindsightRecall("q", { apiUrl: "http://h", bank: "b", fetcher });
    expect(seen).toEqual(["Bearer secret-token", null]);
  });

  test("caps the number of results and the size of each", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ text: `${i}:` + "x".repeat(2000) }));
    const text = await hindsightRecall("q", { apiUrl: "http://h", bank: "b", fetcher: ok(many) });
    expect(text.split("\n- ").length).toBeLessThanOrEqual(4);
    expect(text.length).toBeLessThan(1400);
  });

  test("empty results give an empty string", async () => {
    expect(await hindsightRecall("q", { apiUrl: "http://h", bank: "b", fetcher: ok([]) })).toBe("");
  });

  test("a non-ok answer throws so the hook can skip it", async () => {
    await expect(hindsightRecall("q", { apiUrl: "http://h", bank: "b", fetcher: async () => new Response("nope", { status: 500 }) })).rejects.toThrow("500");
  });
});

describe("runHook with Hindsight", () => {
  const prompt = "a substantive question here";

  test("injects Hindsight as its own labelled section alongside the runtime", async () => {
    const out = hookJson(await runHook({ prompt }, deps({
      recall: async () => [{ source: "bruno_entity", content: "from runtime" }],
      hindsight: { label: "coding-agent::anima", recall: async () => "- from hindsight" },
    })));
    expect(out.additionalContext).toContain("from runtime");
    expect(out.additionalContext).toContain("Hindsight, bank coding-agent::anima");
    expect(out.additionalContext).toContain("- from hindsight");
  });

  test("queries the runtime and Hindsight in parallel, not one after the other", async () => {
    const slow = <T,>(v: T) => () => new Promise<T>((r) => setTimeout(() => r(v), 120));
    const t0 = Date.now();
    await runHook({ prompt }, deps({
      recall: slow([{ source: "rag", content: "r" }]),
      hindsight: { label: "b", recall: slow("- h") },
      deadlineMs: 1000,
    }));
    expect(Date.now() - t0).toBeLessThan(220);
  });

  test("Hindsight alone is enough to inject, even when the runtime has nothing", async () => {
    const out = hookJson(await runHook({ prompt }, deps({ hindsight: { label: "b", recall: async () => "- only hindsight" } })));
    expect(out.additionalContext).toContain("- only hindsight");
    expect(out.additionalContext).not.toContain("recall unavailable");
  });

  test("a failing or hung Hindsight is skipped silently and never delays past the deadline", async () => {
    const failing = await runHook({ prompt }, deps({ hindsight: { label: "b", recall: async () => { throw new Error("ECONNREFUSED"); } } }));
    expect(failing).toBeUndefined();
    const t0 = Date.now();
    const hung = await runHook({ prompt }, deps({ hindsight: { label: "b", recall: () => new Promise(() => {}) }, deadlineMs: 60 }));
    expect(hung).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(400);
  });

  test("runtime down: Hindsight and the local fallback both appear", async () => {
    const out = hookJson(await runHook({ prompt }, deps({
      recall: async () => { throw new Error("connect ECONNREFUSED"); },
      hindsight: { label: "b", recall: async () => "- h" },
      localRecall: async () => "- [fact#1] local",
    })));
    expect(out.additionalContext).toContain("- h");
    expect(out.additionalContext).toContain("- [fact#1] local");
  });

  test("the project context is appended to the query both sources receive", async () => {
    const seen: string[] = [];
    await runHook({ prompt: "please fix recall-agent.sh" }, deps({
      project: "anima",
      recall: async (q) => { seen.push(q); return []; },
      hindsight: { label: "b", recall: async (q) => { seen.push(q); return ""; } },
    }));
    expect(seen).toEqual(["please fix recall-agent.sh (project: anima)", "please fix recall-agent.sh (project: anima)"]);
  });
});

describe("runHook with a relevance filter", () => {
  const prompt = "how does the per-turn hook build its recall query";
  const items = (...lines: string[]) => lines.map((l) => `- ${l}`).join("\n");

  test("drops the memories the filter rejects, in both the Hindsight and local blocks", async () => {
    const out = hookJson(await runHook({ prompt }, deps({
      recall: async () => { throw new Error("down"); },
      hindsight: { label: "b", recall: async () => items("hook note", "novel chapters") },
      localRecall: async () => items("[heuristic#1] drift rule", "[fact#2] recall query note"),
      relevance: async (_q, cands) => cands.map((c) => !/novel|drift/.test(c)),
    })));
    expect(out.additionalContext).toContain("hook note");
    expect(out.additionalContext).toContain("recall query note");
    expect(out.additionalContext).not.toContain("novel chapters");
    expect(out.additionalContext).not.toContain("drift rule");
  });

  test("a block whose memories are all rejected is omitted; if everything goes, nothing is injected", async () => {
    const partly = hookJson(await runHook({ prompt }, deps({
      recall: async () => { throw new Error("down"); },
      hindsight: { label: "b", recall: async () => items("keep me") },
      localRecall: async () => items("drop me"),
      relevance: async (_q, cands) => cands.map((c) => c.includes("keep")),
    })));
    expect(partly.additionalContext).toContain("Hindsight");
    expect(partly.additionalContext).not.toContain("local bruno-entity");
    const none = await runHook({ prompt }, deps({
      hindsight: { label: "b", recall: async () => items("a") },
      relevance: async (_q, cands) => cands.map(() => false),
    }));
    expect(none).toBeUndefined();
  });

  test("runtime results are not sent to the filter and are never dropped by it", async () => {
    let sent: string[] = [];
    const out = hookJson(await runHook({ prompt }, deps({
      recall: async () => [{ source: "bruno_entity", content: "runtime memory" }],
      hindsight: { label: "b", recall: async () => items("h") },
      relevance: async (_q, cands) => { sent = cands; return cands.map(() => false); },
    })));
    expect(out.additionalContext).toContain("runtime memory");
    expect(sent).toEqual(["- h"]);
  });

  test("sensitive memories are never sent out, and are dropped when the prompt itself is not sensitive", async () => {
    let sent: string[] = [];
    const out = hookJson(await runHook({ prompt }, deps({
      hindsight: { label: "b", recall: async () => items("hook note", "a secret-topic note from the archive") },
      relevance: async (_q, cands) => { sent = cands; return cands.map(() => true); },
    })));
    expect(sent).toEqual(["- hook note"]);
    expect(out.additionalContext).toContain("hook note");
    expect(out.additionalContext).not.toContain("secret-topic");
  });

  test("a sensitive prompt skips the filter entirely and keeps everything as retrieved", async () => {
    let called = false;
    const out = hookJson(await runHook({ prompt: "secret-topic mode, do you remember last time" }, deps({
      hindsight: { label: "b", recall: async () => items("a secret-topic note from the archive") },
      relevance: async (_q, cands) => { called = true; return cands.map(() => false); },
    })));
    expect(called).toBe(false);
    expect(out.additionalContext).toContain("secret-topic note");
  });

  test("without a sensitive-terms file the guard is not ready: nothing is sent out and every memory is kept as retrieved", async () => {
    let called = false;
    const out = hookJson(await runHook({ prompt }, deps({
      guard: createGuard(null),
      hindsight: { label: "b", recall: async () => items("hook note", "a secret-topic note from the archive") },
      relevance: async (_q, cands) => { called = true; return cands.map(() => false); },
    })));
    expect(called).toBe(false);
    expect(out.additionalContext).toContain("hook note");
    expect(out.additionalContext).toContain("secret-topic note");
  });

  test("a failing or hung filter keeps every memory (fail-open) within the deadline", async () => {
    const base = { hindsight: { label: "b", recall: async () => items("one", "two") } };
    const failed = hookJson(await runHook({ prompt }, deps({ ...base, relevance: async () => { throw new Error("boom"); } })));
    expect(failed.additionalContext).toContain("- one");
    const t0 = Date.now();
    const hung = hookJson(await runHook({ prompt }, deps({ ...base, relevance: () => new Promise(() => {}), filterDeadlineMs: 60 })));
    expect(Date.now() - t0).toBeLessThan(400);
    expect(hung.additionalContext).toContain("- two");
  });

  test("the filter receives the composed query", async () => {
    let seen = "";
    await runHook({ prompt: "please fix recall-agent.sh" }, deps({
      project: "anima",
      hindsight: { label: "b", recall: async () => items("x") },
      relevance: async (q, c) => { seen = q; return c.map(() => true); },
    }));
    expect(seen).toBe("please fix recall-agent.sh (project: anima)");
  });
});
