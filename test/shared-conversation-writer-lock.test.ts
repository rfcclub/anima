import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireSharedWriterLock, SharedWriterLockError } from "../src/conversation/writer-lock";

let dir: string;
beforeEach(() => { dir = join(tmpdir(), `shared-writer-lock-${Date.now()}-${Math.random()}`); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("shared conversation writer lock", () => {
test("refuses a second owner and only removes the lock it owns", () => {
    const dbPath = join(dir, "sessions.db");
    const first = acquireSharedWriterLock(dbPath, { pid: process.pid, startedAt: "one" });

    expect(() => acquireSharedWriterLock(dbPath, { pid: 200, startedAt: "two" })).toThrow(SharedWriterLockError);
    expect(existsSync(`${dbPath}.shared-writer.lock`)).toBe(true);
    first.release();
  expect(existsSync(`${dbPath}.shared-writer.lock`)).toBe(false);
});

test("reclaims a lock only when its recorded owner PID is no longer live", () => {
  const dbPath = join(dir, "sessions.db");
  const first = acquireSharedWriterLock(dbPath, { pid: 100, startedAt: "one" });
  first.release = () => undefined;

  const recovered = acquireSharedWriterLock(dbPath, { pid: 200, startedAt: "two" }, {
    isProcessAlive: (pid) => pid !== 100,
  });

  expect(existsSync(`${dbPath}.shared-writer.lock`)).toBe(true);
  recovered.release();
  expect(existsSync(`${dbPath}.shared-writer.lock`)).toBe(false);
});
});
