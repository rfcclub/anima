import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WRAPUP_SECTIONS,
  buildWrapupDocument,
  retainWrapup,
  wrapupDocumentId,
} from "../../src/memory/hindsight-wrapup";

const TOKEN = "tok-SECRET-1234567890";

function configFile() {
  const dir = mkdtempSync(join(tmpdir(), "hs-cfg-"));
  const path = join(dir, "coding-agent.json");
  writeFileSync(path, JSON.stringify({ serverMode: "self-hosted", apiUrl: "http://hs.test:8891", apiToken: TOKEN }));
  return path;
}

const complete = [
  "## Decisions made and why",
  "- Kept the wrap-up as one document, not one per section: the session id is the identity.",
  "",
  "## What shipped",
  "- #674: wrap-up ingest (PR #701).",
  "",
  "## Open work",
  "- Compare 20 sessions before turning transcripts off.",
  "",
  "## Owner corrections",
  "- None.",
  "",
  "## Claims needing verification",
  "- That the Key decisions page cites the wrap-up after a refresh.",
].join("\n");

describe("wrap-up document id", () => {
  test("is derived from the session id so a second write addresses the same document", () => {
    expect(wrapupDocumentId("sess-abc_123")).toBe("wrapup-sess-abc_123");
    expect(wrapupDocumentId("sess-abc_123")).toBe(wrapupDocumentId("sess-abc_123"));
  });

  test("two different sessions never share a document id", () => {
    // Folding `_` to `-` would make one session's wrap-up replace the other's.
    expect(wrapupDocumentId("sess-a_b")).not.toBe(wrapupDocumentId("sess-a-b"));
  });

  test("accepts the ids the runtime really produces, including `:` and `.`", () => {
    // SessionLifecycle: `channel-<channelId>-<agentId>-<uuid>`, where the channel is
    // `work:<workId>`, `remote:<caller>`, `ambient:<placeId>` or a Telegram chat id.
    expect(wrapupDocumentId("channel-work:w9224619e1-erza-0f9f4a1c-2b7e-4f4f-9c1f-1d2e3f4a5b6c")).toBe(
      "wrapup-channel-work:w9224619e1-erza-0f9f4a1c-2b7e-4f4f-9c1f-1d2e3f4a5b6c",
    );
    expect(wrapupDocumentId("channel-123456.789-aura-abc")).toBe("wrapup-channel-123456.789-aura-abc");
  });

  test("rejects an id the server could not key a document on", () => {
    expect(() => wrapupDocumentId("")).toThrow();
    expect(() => wrapupDocumentId("../../etc/passwd")).toThrow();
    expect(() => wrapupDocumentId("sess/one")).toThrow();
  });
});

describe("buildWrapupDocument", () => {
  test("carries the fixed sections, the wrapup tag and the session-derived id", () => {
    const doc = buildWrapupDocument({ sessionId: "sess-1", content: complete });
    expect(doc.documentId).toBe("wrapup-sess-1");
    expect(doc.tags).toContain("wrapup");
    expect(doc.content).toContain("## Decisions made and why");
    for (const section of WRAPUP_SECTIONS) expect(doc.content).toContain(section);
  });

  test("refuses a wrap-up missing a section instead of writing a partial record", () => {
    const partial = complete.replace("## Owner corrections", "## Notes");
    expect(() => buildWrapupDocument({ sessionId: "sess-1", content: partial })).toThrow(/Owner corrections/);
  });

  test("refuses an empty section body", () => {
    const empty = complete.replace("- None.", "");
    expect(() => buildWrapupDocument({ sessionId: "sess-1", content: empty })).toThrow(/Owner corrections/);
  });

  test("refuses sections out of order", () => {
    const headings = complete.match(/^## .*$/gm)!;
    const swapped = complete.replace(headings[0]!, "\u0000").replace(headings[1]!, headings[0]!).replace("\u0000", headings[1]!);
    expect(swapped.indexOf(headings[1]!)).toBeLessThan(swapped.indexOf(headings[0]!));
    expect(() => buildWrapupDocument({ sessionId: "sess-1", content: swapped })).toThrow(/out of order/);
  });
});

describe("retainWrapup", () => {
  test("sends one document with the session-derived id and the wrapup tag", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;

    const first = await retainWrapup({ bank: "anima-cleo", sessionId: "sess-1", content: complete, configPath: configFile(), fetchFn });
    await retainWrapup({ bank: "anima-cleo", sessionId: "sess-1", content: complete, configPath: configFile(), fetchFn });

    expect(first.outcome).toBe("ok");
    expect(first.documentId).toBe("wrapup-sess-1");
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url).toBe("http://hs.test:8891/v1/default/banks/anima-cleo/memories");
    expect(seen[0]!.init.method).toBe("POST");
    const ids = seen.map((call) => {
      const body = JSON.parse(String(call.init.body)) as {
        async: boolean;
        items: Array<{ document_id: string; tags: string[]; context: string; strategy: string }>;
      };
      expect(body.async).toBe(false);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.tags).toContain("wrapup");
      expect(body.items[0]!.context).toBe("ingested document");
      expect(body.items[0]!.strategy).toBe("document");
      return body.items[0]!.document_id;
    });
    expect(ids).toEqual(["wrapup-sess-1", "wrapup-sess-1"]);
  });

  test("a queued retain is not reported as retained and keeps its operation id", async () => {
    const queued = await retainWrapup({
      bank: "anima-cleo",
      sessionId: "sess-1",
      content: complete,
      configPath: configFile(),
      fetchFn: (async () =>
        new Response(JSON.stringify({ operation_id: "op-42", status: "queued" }), { status: 202 })) as unknown as typeof fetch,
    });
    expect(queued.outcome).toBe("queued");
    expect(queued.outcome).not.toBe("ok");
    expect(queued.operationId).toBe("op-42");
    expect(queued.documentId).toBe("wrapup-sess-1");
  });

  test("a 200 that still only queues is queued, not ok", async () => {
    const result = await retainWrapup({
      bank: "b",
      sessionId: "s",
      content: complete,
      configPath: configFile(),
      fetchFn: (async () =>
        new Response(JSON.stringify({ operation_id: "op-7" }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(result.outcome).toBe("queued");
    expect(result.operationId).toBe("op-7");
  });

  test("a stalled server is bounded and reported as an error instead of hanging session end", async () => {
    const started = Date.now();
    const result = await retainWrapup({
      bank: "b",
      sessionId: "s",
      content: complete,
      configPath: configFile(),
      timeoutMs: 25,
      fetchFn: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })) as unknown as typeof fetch,
    });
    expect(result.outcome).toBe("error");
    expect(result.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a fetch that ignores the abort signal is still bounded", async () => {
    const started = Date.now();
    const result = await retainWrapup({
      bank: "b",
      sessionId: "s",
      content: complete,
      configPath: configFile(),
      timeoutMs: 25,
      // A host that accepts the connection and never answers, and never honours the signal.
      fetchFn: (() => new Promise(() => {})) as unknown as typeof fetch,
    });
    expect(result.outcome).toBe("error");
    expect(result.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("an invalid wrap-up comes back as a structured error and sends no request", async () => {
    let calls = 0;
    const result = await retainWrapup({
      bank: "b",
      sessionId: "s",
      content: "## Decisions made and why\n- x\n",
      configPath: configFile(),
      fetchFn: (async () => {
        calls++;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result.outcome).toBe("error");
    expect(result.reason).toContain("invalid-wrapup");
    expect(result.reason).toContain("missing or empty section");
    expect(calls).toBe(0);
  });

  test("a traversal-shaped session id is an error outcome, not a thrown one", async () => {
    const result = await retainWrapup({ bank: "b", sessionId: "../../etc/passwd", content: complete, configPath: configFile() });
    expect(result.outcome).toBe("error");
    expect(result.reason).toContain("invalid-wrapup");
  });

  test("never throws: a missing config or a failed write reports an outcome and sends no token in logs", async () => {
    const logs: string[] = [];
    const missing = await retainWrapup({ bank: "b", sessionId: "s", content: complete, configPath: "/nonexistent/cfg.json" });
    expect(missing.outcome).toBe("error");
    expect(missing.reason).toBe("config-unavailable");

    const failing = await retainWrapup({
      bank: "b",
      sessionId: "s",
      content: complete,
      configPath: configFile(),
      fetchFn: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
      log: (_level, msg, fields) => logs.push(`${msg} ${JSON.stringify(fields ?? {})}`),
    });
    expect(failing.outcome).toBe("error");
    expect(failing.reason).toBe("status-500");
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
});

describe("retainWrapup: an unconfirmed or unreadable body is never `ok`", () => {
  test("a 202 with no body is queued, not retained", async () => {
    const result = await retainWrapup({
      bank: "b",
      sessionId: "s",
      content: complete,
      configPath: configFile(),
      fetchFn: (async () => new Response(null, { status: 202 })) as unknown as typeof fetch,
    });
    expect(result.outcome).toBe("queued");
    expect(result.documentId).toBe("wrapup-s");
  });

  test("a 200 whose body is not JSON is an error, not a retained document", async () => {
    const result = await retainWrapup({
      bank: "b",
      sessionId: "s",
      content: complete,
      configPath: configFile(),
      fetchFn: (async () => new Response("<html>gateway</html>", { status: 200 })) as unknown as typeof fetch,
    });
    expect(result.outcome).toBe("error");
    expect(result.reason).toBe("unreadable-body");
  });

  test("a 200 with an empty body is an error, not a retained document", async () => {
    const result = await retainWrapup({
      bank: "b",
      sessionId: "s",
      content: complete,
      configPath: configFile(),
      fetchFn: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    });
    expect(result.outcome).toBe("error");
    expect(result.reason).toBe("unreadable-body");
  });

  test("a 200 whose body states no status is an error, not a retained document", async () => {
    const result = await retainWrapup({
      bank: "b",
      sessionId: "s",
      content: complete,
      configPath: configFile(),
      fetchFn: (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch,
    });
    expect(result.outcome).toBe("error");
    expect(result.reason).toBe("unconfirmed");
  });

  test("a stalled body is bounded and reported as a timeout", async () => {
    const started = Date.now();
    const result = await retainWrapup({
      bank: "b",
      sessionId: "s",
      content: complete,
      configPath: configFile(),
      timeoutMs: 30,
      // Headers arrive, the body never completes.
      fetchFn: (async () => new Response(new ReadableStream({ start() {} }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(result.outcome).toBe("error");
    expect(result.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a 202 whose body stalls is still queued rather than held to the deadline as an error", async () => {
    const result = await retainWrapup({
      bank: "b",
      sessionId: "s",
      content: complete,
      configPath: configFile(),
      timeoutMs: 30,
      fetchFn: (async () => new Response(new ReadableStream({ start() {} }), { status: 202 })) as unknown as typeof fetch,
    });
    expect(result.outcome).toBe("queued");
    expect(result.documentId).toBe("wrapup-s");
  });
});
