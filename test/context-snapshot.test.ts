import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshot, writeSnapshot } from "../src/memory/context-snapshot";

let tempDir: string;
let previousSnapshotDir: string | undefined;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  previousSnapshotDir = process.env.ANIMA_SNAPSHOT_DIR;
  process.env.ANIMA_SNAPSHOT_DIR = tempDir;
});

afterEach(() => {
  if (previousSnapshotDir === undefined) {
    delete process.env.ANIMA_SNAPSHOT_DIR;
  } else {
    process.env.ANIMA_SNAPSHOT_DIR = previousSnapshotDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

test("readSnapshot returns null when no snapshot exists", () => {
  expect(readSnapshot("eli")).toBeNull();
});

test("writeSnapshot writes agent snapshot and readSnapshot reads it back", () => {
  writeSnapshot("eli", "active context\nopen question");

  expect(readSnapshot("eli")).toBe("active context\nopen question");
  expect(existsSync(join(tempDir, "eli.snapshot"))).toBe(true);
});

test("snapshot filenames are constrained to agent basename", () => {
  writeSnapshot("../eli", "safe");

  expect(readSnapshot("../eli")).toBe("safe");
  expect(existsSync(join(tempDir, "..", "eli.snapshot"))).toBe(false);
  expect(existsSync(join(tempDir, "___eli.snapshot"))).toBe(true);
});
