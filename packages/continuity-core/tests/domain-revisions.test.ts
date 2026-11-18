import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainRevisions } from "../src/domain-revisions";

let tmpDir: string | undefined;

function freshDb(): DomainRevisions {
  tmpDir = mkdtempSync(join(tmpdir(), "continuity-core-domain-rev-"));
  return new DomainRevisions(join(tmpDir, "continuity.db"));
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe("domain-revisions", () => {
  test("getRevision returns sentinel \"0\" when no row exists", () => {
    const revisions = freshDb();
    expect(revisions.getRevision("bruno", "identity")).toBe("0");
    revisions.close();
  });

  test("incrementRevision is atomic and returns the new value as a string", () => {
    const revisions = freshDb();
    expect(revisions.incrementRevision("bruno", "identity", 1000)).toBe("1");
    expect(revisions.incrementRevision("bruno", "identity", 2000)).toBe("2");
    expect(revisions.getRevision("bruno", "identity")).toBe("2");
    revisions.close();
  });

  test("counters are independent per (agentId, scope)", () => {
    const revisions = freshDb();
    revisions.incrementRevision("bruno", "identity");
    expect(revisions.getRevision("bruno", "private")).toBe("0");
    expect(revisions.getRevision("eli", "identity")).toBe("0");
    revisions.close();
  });

  test("genuinely concurrent increments from separate OS processes do not lose an update", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "continuity-core-domain-rev-"));
    const dbPath = join(tmpDir, "continuity.db");
    const workerPath = join(import.meta.dir, "fixtures", "increment-worker.ts");
    const countPerWorker = 20;

    // Pre-create the file/schema/WAL-mode switch once, in this process —
    // that one-time setup racing across two brand-new processes is a test-
    // harness startup collision, not the thing under test. In production the
    // schema is created once, on an agent's first-ever turn.
    new DomainRevisions(dbPath).close();

    // Two REAL subprocesses racing to increment the same counter concurrently —
    // the old SELECT-then-computed-write implementation could lose updates
    // under genuine concurrency; a single-process Promise.all of synchronous
    // calls (the prior version of this test) cannot actually exercise that race.
    const [a, b] = await Promise.all([
      Bun.spawn(["bun", workerPath, dbPath, "bruno", "identity", String(countPerWorker)]).exited,
      Bun.spawn(["bun", workerPath, dbPath, "bruno", "identity", String(countPerWorker)]).exited,
    ]);
    expect(a).toBe(0);
    expect(b).toBe(0);

    const revisions = new DomainRevisions(dbPath);
    expect(revisions.getRevision("bruno", "identity")).toBe(String(countPerWorker * 2));
    revisions.close();
  }, 15000);

  test("never reads from any memory adapter's bootstrap()/recall() — the class has no such dependency", () => {
    // Structural check: DomainRevisions only exposes getRevision/incrementRevision/close.
    const revisions = freshDb();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(revisions));
    expect(methods.sort()).toEqual(["close", "constructor", "getRevision", "incrementRevision"]);
    revisions.close();
  });
});
