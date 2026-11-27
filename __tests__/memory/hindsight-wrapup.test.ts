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
  test("is derived from the session id so a second write replaces the first", () => {
    expect(wrapupDocumentId("sess-abc_123")).toBe("wrapup-sess-abc_123");
    expect(wrapupDocumentId("sess-abc_123")).toBe(wrapupDocumentId("sess-abc_123"));
  });

  test("two different sessions never share a document id", () => {
    // Folding `_` to `-` would make one session's wrap-up replace the other's.
    expect(wrapupDocumentId("sess-a_b")).not.toBe(wrapupDocumentId("sess-a-b"));
  });

  test("rejects an id the server could not key a document on", () => {
    expect(() => wrapupDocumentId("")).toThrow();
    expect(() => wrapupDocumentId("../../etc/passwd")).not.toBe("wrapup-etc-passwd");
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
});

describe("retainWrapup", () => {
  test("writes the document through the bank memories endpoint and the same id twice yields one document", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ operation_id: "op-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const first = await retainWrapup({ bank: "anima-cleo", sessionId: "sess-1", content: complete, configPath: configFile(), fetchFn });
    const second = await retainWrapup({ bank: "anima-cleo", sessionId: "sess-1", content: complete, configPath: configFile(), fetchFn });

    expect(first.outcome).toBe("ok");
    expect(second.outcome).toBe("ok");
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url).toBe("http://hs.test:8891/v1/default/banks/anima-cleo/memories");
    expect(seen[0]!.init.method).toBe("POST");
    const ids = seen.map((call) => {
      const body = JSON.parse(String(call.init.body)) as { items: Array<{ document_id: string; tags: string[] }> };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.tags).toContain("wrapup");
      return body.items[0]!.document_id;
    });
    expect(ids).toEqual(["wrapup-sess-1", "wrapup-sess-1"]);
  });

  test("never throws: a missing config or a failed write reports an outcome and sends no token in logs", async () => {
    const logs: string[] = [];
    const missing = await retainWrapup({ bank: "b", sessionId: "s", content: complete, configPath: "/nonexistent/cfg.json" });
    expect(missing.outcome).toBe("error");

    const failing = await retainWrapup({
      bank: "b",
      sessionId: "s",
      content: complete,
      configPath: configFile(),
      fetchFn: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
      log: (_level, msg, fields) => logs.push(`${msg} ${JSON.stringify(fields ?? {})}`),
    });
    expect(failing.outcome).toBe("error");
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
});
