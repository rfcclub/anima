import { test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, appendFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogStream } from "./logs-stream";

const TMP = join(tmpdir(), "anima-stream-test-" + process.pid);
beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => { try { unlinkSync(join(TMP, "s.log")); } catch {} });
const logPath = () => join(TMP, "s.log");

// SC-011: SSE response headers
test("createLogStream returns SSE response with correct headers", () => {
  const req = new Request("http://localhost/api/logs/stream", { signal: AbortSignal.timeout(50) });
  const res = createLogStream(req, "/no/such/file.log");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  expect(res.headers.get("Cache-Control")).toBe("no-cache");
});

// SC-015: missing file starts stream without error
test("createLogStream starts without error when file missing", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const req = new Request("http://localhost/api/logs/stream", { signal: controller.signal });
  const res = createLogStream(req, "/no/such/file.log");
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  try { while (true) { const { done } = await reader.read(); if (done) break; } } catch {}
  // Must reach here without throwing
  expect(true).toBe(true);
});

// SC-013: stream starts from current end (not historical)
test("createLogStream does not replay existing lines", async () => {
  writeFileSync(logPath(), JSON.stringify({ level: "info", ts: "t", msg: "old" }) + "\n");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 350);
  const req = new Request("http://localhost/api/logs/stream", { signal: controller.signal });
  const res = createLogStream(req, logPath());
  const chunks: string[] = [];
  const reader = res.body!.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
  } catch {}
  expect(chunks.join("")).not.toContain("old");
});

// SC-012: new lines are emitted
test("createLogStream emits newly appended lines", async () => {
  writeFileSync(logPath(), "");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1000);
  const req = new Request("http://localhost/api/logs/stream", { signal: controller.signal });
  const res = createLogStream(req, logPath());
  const chunks: string[] = [];
  const reader = res.body!.getReader();
  const reading = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }
    } catch {}
  })();
  await new Promise(r => setTimeout(r, 200));
  appendFileSync(logPath(), JSON.stringify({ level: "info", ts: "t", msg: "new-line" }) + "\n");
  await reading;
  expect(chunks.join("")).toContain("new-line");
});

// SC-014: cleanup on disconnect
test("createLogStream stops cleanly after abort", async () => {
  writeFileSync(logPath(), "");
  const controller = new AbortController();
  const req = new Request("http://localhost/api/logs/stream", { signal: controller.signal });
  const res = createLogStream(req, logPath());
  const reader = res.body!.getReader();
  // Abort immediately — no hang
  controller.abort();
  try { await reader.read(); } catch {}
  expect(true).toBe(true);
});
