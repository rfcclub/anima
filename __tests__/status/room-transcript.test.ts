import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTurn, readTranscript } from "../../src/narrative/room-transcript";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anima-transcript-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("appendTurn + readTranscript round-trip", () => {
  appendTurn("bruno", { speaker: "user", role: "user", content: "hi" }, dir);
  appendTurn("bruno", { speaker: "bruno", role: "assistant", content: "hello" }, dir);
  const turns = readTranscript("bruno", dir);
  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({ speaker: "user", content: "hi" });
  expect(turns[1]).toMatchObject({ speaker: "bruno", content: "hello" });
  expect(typeof turns[0].ts).toBe("number");
});

test("readTranscript: missing file → []", () => {
  expect(readTranscript("nonexistent", dir)).toEqual([]);
});

// Path-traversal guard (defense-in-depth). roomId keys a transcript file;
// it must never carry path separators or `..` segments. Existing callers
// already constrain this (roster id, URL regex), but the function's own
// contract must reject traversal so a future caller cannot escape base.
test("transcriptPath: rejects roomId with path separators / traversal", () => {
  expect(() => appendTurn("../etc", { speaker: "user", role: "user", content: "x" }, dir)).toThrow();
  expect(() => appendTurn("..", { speaker: "user", role: "user", content: "x" }, dir)).toThrow();
  expect(() => appendTurn("a/b", { speaker: "user", role: "user", content: "x" }, dir)).toThrow();
  expect(() => appendTurn("a.b", { speaker: "user", role: "user", content: "x" }, dir)).toThrow();
  expect(() => readTranscript("../etc", dir)).toThrow();
});

test("transcriptPath: accepts a normal roomId", () => {
  appendTurn("eli", { speaker: "user", role: "user", content: "hi" }, dir);
  expect(readTranscript("eli", dir)).toHaveLength(1);
});
