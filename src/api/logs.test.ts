import { test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readLastLines, parseLogLine, filterEntries, getLogEntries, handleApiLogs } from "./logs";

const TMP = join(tmpdir(), "anima-log-test-" + process.pid);

beforeEach(() => { mkdirSync(TMP, { recursive: true }); });
afterEach(() => { try { unlinkSync(join(TMP, "test.log")); } catch {} });

const logPath = () => join(TMP, "test.log");
const write = (content: string) => writeFileSync(logPath(), content, "utf8");

// SC-004: missing file
test("readLastLines returns [] when file does not exist", async () => {
  const result = await readLastLines("/no/such/file.log", 10);
  expect(result).toEqual([]);
});

// SC-001: reads last N lines
test("readLastLines returns last N non-empty lines", async () => {
  write(Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n") + "\n");
  const result = await readLastLines(logPath(), 5);
  expect(result).toHaveLength(5);
  expect(result[4]).toBe("line9");
});

// SC-010: malformed lines skipped by parseLogLine
test("parseLogLine returns null for non-JSON", () => {
  expect(parseLogLine("not json")).toBeNull();
  expect(parseLogLine("")).toBeNull();
});

test("parseLogLine returns null when required fields missing", () => {
  expect(parseLogLine(JSON.stringify({ level: "info" }))).toBeNull();
});

test("parseLogLine parses valid log entry", () => {
  const entry = { level: "info", ts: "2026-01-01T00:00:00Z", msg: "hello" };
  expect(parseLogLine(JSON.stringify(entry))).toEqual(entry);
});

// SC-005: level filter
test("filterEntries by level", () => {
  const entries = [
    { level: "info", ts: "t", msg: "a" },
    { level: "error", ts: "t", msg: "b" },
  ];
  expect(filterEntries(entries, { level: "error" })).toEqual([entries[1]]);
});

// SC-006: unknown level
test("filterEntries returns [] for unknown level", () => {
  const entries = [{ level: "info", ts: "t", msg: "hello" }];
  expect(filterEntries(entries, { level: "nonexistent" })).toEqual([]);
});

// SC-007: keyword filter matches msg
test("filterEntries by q matches msg", () => {
  const entries = [
    { level: "info", ts: "t", msg: "telegram polling" },
    { level: "info", ts: "t", msg: "dream started" },
  ];
  expect(filterEntries(entries, { q: "TELEGRAM" })).toEqual([entries[0]]);
});

// SC-008: keyword filter matches any string field
test("filterEntries by q matches any string field", () => {
  const entries = [
    { level: "info", ts: "t", msg: "request", agent: "bruno" },
    { level: "info", ts: "t", msg: "request", agent: "quin" },
  ];
  expect(filterEntries(entries, { q: "bruno" })).toEqual([entries[0]]);
});

// SC-009: no match
test("filterEntries returns [] when no match", () => {
  const entries = [{ level: "info", ts: "t", msg: "hello" }];
  expect(filterEntries(entries, { q: "zzz_no_match_zzz" })).toEqual([]);
});

// SC-004: getLogEntries with missing file
test("getLogEntries returns [] when file missing", async () => {
  const result = await getLogEntries({ filePath: "/no/such/file.log" });
  expect(result).toEqual([]);
});

// SC-010: getLogEntries skips malformed lines
test("getLogEntries skips malformed lines", async () => {
  const good = JSON.stringify({ level: "info", ts: "2026-01-01T00:00:00Z", msg: "ok" });
  write("not json\n" + good + "\n");
  const result = await getLogEntries({ filePath: logPath() });
  expect(result).toHaveLength(1);
  expect(result[0].msg).toBe("ok");
});

// SC-002: lines param
test("getLogEntries respects lines param", async () => {
  const lines = Array.from({ length: 10 }, (_, i) =>
    JSON.stringify({ level: "info", ts: `2026-01-01T00:00:0${i}Z`, msg: `msg${i}` })
  ).join("\n") + "\n";
  write(lines);
  const result = await getLogEntries({ filePath: logPath(), lines: 3 });
  expect(result).toHaveLength(3);
});

// SC-003: ordered ascending by ts
test("getLogEntries entries are ordered oldest-first", async () => {
  const lines = [
    JSON.stringify({ level: "info", ts: "2026-01-01T00:00:01Z", msg: "first" }),
    JSON.stringify({ level: "info", ts: "2026-01-01T00:00:02Z", msg: "second" }),
  ].join("\n") + "\n";
  write(lines);
  const result = await getLogEntries({ filePath: logPath() });
  expect(result[0].msg).toBe("first");
  expect(result[1].msg).toBe("second");
});

// SC-001, SC-004: handleApiLogs returns 200 JSON array
test("handleApiLogs returns 200 with JSON array", async () => {
  const req = new Request("http://localhost/api/logs");
  const res = await handleApiLogs(req, "/no/such/file.log");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body)).toBe(true);
});

// SC-002: ?lines param
test("handleApiLogs respects ?lines param", async () => {
  const content = Array.from({ length: 10 }, (_, i) =>
    JSON.stringify({ level: "info", ts: `2026-01-01T00:00:0${i}Z`, msg: `m${i}` })
  ).join("\n") + "\n";
  write(content);
  const req = new Request("http://localhost/api/logs?lines=3");
  const res = await handleApiLogs(req, logPath());
  const body = await res.json() as unknown[];
  expect(body.length).toBeLessThanOrEqual(3);
});

// SC-005: ?level param
test("handleApiLogs filters by ?level", async () => {
  const content = [
    JSON.stringify({ level: "info", ts: "2026-01-01T00:00:01Z", msg: "ok" }),
    JSON.stringify({ level: "error", ts: "2026-01-01T00:00:02Z", msg: "fail" }),
  ].join("\n") + "\n";
  write(content);
  const req = new Request("http://localhost/api/logs?level=error");
  const res = await handleApiLogs(req, logPath());
  const body = await res.json() as Array<{ level: string }>;
  expect(body.every(e => e.level === "error")).toBe(true);
});
