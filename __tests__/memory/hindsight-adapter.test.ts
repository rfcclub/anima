import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HindsightRecallAdapter } from "../../src/memory/hindsight-adapter";

const TOKEN = "tok-SECRET-1234567890";

function configFile(body: unknown = { serverMode: "self-hosted", apiUrl: "http://hs.test:8891", apiToken: TOKEN }) {
  const dir = mkdtempSync(join(tmpdir(), "hs-cfg-"));
  const p = join(dir, "coding-agent.json");
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}

function make(fetchFn: typeof fetch, extra: Record<string, unknown> = {}) {
  const logs: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const adapter = new HindsightRecallAdapter({
    bank: "anima-cleo-pilot",
    namespace: "cleo",
    timeoutMs: 200,
    configPath: configFile(),
    fetchFn,
    log: (level, msg, fields) => logs.push({ level, msg, fields: fields ?? {} }),
    ...extra,
  });
  return { adapter, logs };
}

const okResponse = (results: unknown[]) =>
  new Response(JSON.stringify({ results }), { status: 200, headers: { "content-type": "application/json" } });

describe("HindsightRecallAdapter", () => {
  test("posts to the bank recall endpoint with the bearer token and maps results to entries", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const { adapter } = make((async (url: string, init: RequestInit) => {
      seen = { url, init };
      return okResponse([{ id: "a", text: "decided: close ui sessions after the dream", mentioned_at: "2026-10-26T00:00:00Z" }]);
    }) as unknown as typeof fetch);

    const rows = await adapter.recall("dream sessions", { topK: 3 });

    expect(seen!.url).toBe("http://hs.test:8891/v1/default/banks/anima-cleo-pilot/memories/recall");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(seen!.init.body));
    expect(body.query).toBe("dream sessions");
    expect(body.budget).toBe("low");
    expect(rows).toEqual([
      { id: "a", namespace: "cleo", content: "decided: close ui sessions after the dream", type: "fact", timestamp: "2026-10-26T00:00:00Z" },
    ]);
  });

  test("cuts results to topK", async () => {
    const results = Array.from({ length: 10 }, (_, i) => ({ id: String(i), text: `fact ${i}`, mentioned_at: "2026-10-26T00:00:00Z" }));
    const { adapter } = make((async () => okResponse(results)) as unknown as typeof fetch);
    expect((await adapter.recall("x", { topK: 4 })).length).toBe(4);
  });

  test("returns [] without throwing on a non-2xx response, and logs outcome error", async () => {
    const { adapter, logs } = make((async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
    expect(await adapter.recall("x")).toEqual([]);
    expect(logs.at(-1)!.fields.outcome).toBe("error");
  });

  test("returns [] on timeout and logs outcome timeout", async () => {
    const { adapter, logs } = make(((_url: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch);
    const t = Date.now();
    expect(await adapter.recall("x")).toEqual([]);
    expect(Date.now() - t).toBeLessThan(1500);
    expect(logs.at(-1)!.fields.outcome).toBe("timeout");
  });

  test("returns [] when the config file is missing or malformed", async () => {
    const calls: number[] = [];
    const f = (async () => { calls.push(1); return okResponse([]); }) as unknown as typeof fetch;
    const missing = make(f, { configPath: join(tmpdir(), "does-not-exist-hs.json") });
    expect(await missing.adapter.recall("x")).toEqual([]);
    const bad = make(f, { configPath: configFile("{not json") });
    expect(await bad.adapter.recall("x")).toEqual([]);
    expect(calls.length).toBe(0);
  });

  test("never puts the token, the query or result text in a log line", async () => {
    const { adapter, logs } = make((async () => okResponse([{ id: "a", text: "private-result-text", mentioned_at: "2026-10-26T00:00:00Z" }])) as unknown as typeof fetch);
    await adapter.recall("private-query-text");
    const failing = make((async () => { throw new Error(`boom ${TOKEN}`); }) as unknown as typeof fetch);
    await failing.adapter.recall("private-query-text");
    const all = JSON.stringify([...logs, ...failing.logs]);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("private-query-text");
    expect(all).not.toContain("private-result-text");
    expect(logs.at(-1)!.fields).toMatchObject({ agent: "cleo", bank: "anima-cleo-pilot", outcome: "ok", count: 1 });
    expect(typeof logs.at(-1)!.fields.latencyMs).toBe("number");
  });

  test("store does nothing", async () => {
    const calls: number[] = [];
    const { adapter } = make((async () => { calls.push(1); return okResponse([]); }) as unknown as typeof fetch);
    await adapter.store({ namespace: "cleo", content: "x", type: "fact", timestamp: "2026-10-27T00:00:00Z" });
    expect(calls.length).toBe(0);
  });
});

describe("HindsightRecallAdapter timeout validation", () => {
  test("a zero or negative timeout falls back to the default instead of aborting every call", async () => {
    const { HindsightRecallAdapter } = await import("../../src/memory/hindsight-adapter");
    for (const bad of [0, -5, Number.NaN]) {
      const a = new HindsightRecallAdapter({ bank: "b", namespace: "cleo", timeoutMs: bad, configPath: "/nonexistent", fetchFn: (async () => new Response(JSON.stringify({ results: [{ text: "x", mentioned_at: "2026-10-27T00:00:00Z" }] }), { status: 200 })) as unknown as typeof fetch });
      expect((a as unknown as { timeoutMs: number }).timeoutMs).toBe(6000);
    }
  });
});
