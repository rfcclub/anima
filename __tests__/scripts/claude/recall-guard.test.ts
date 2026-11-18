import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { acquireRecallGuard, recallGuardPath, RECALL_GUARD_SHARDS } from "../../../scripts/claude/recall-guard";
import { runHook, type HookDeps } from "../../../scripts/claude/identity-client";
import { createGuard } from "../../../scripts/claude/sensitive-terms";
const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
const releases: Array<() => void> = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "recall-guard-")); roots.push(directory);
  const deps: HookDeps = { recall: async () => [{ source: "fixture", content: "compiler boundaries" }], noteGate: { shouldNote: () => false, markNoted() {} }, guard: createGuard({ phrases: ["private"], words: [] }), dedup: { directory } };
  return { directory, deps };
}
const input = { prompt: "inspect compiler boundaries", session_id: "fixture" };
const context = (out: string | undefined): string => out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";
function acquire(directory: string, session = "fixture") { const release = acquireRecallGuard(directory, session); if (release) releases.push(release); return release; }
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const child of children.splice(0)) if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("OL-3 stable 64-shard mapping uses SHA256 first uint32 big endian without session text", () => {
  expect(RECALL_GUARD_SHARDS).toBe(64);
  for (const id of ["fixture", "other", "sensitive-session-name", ...Array.from({ length: 1000 }, (_, i) => `s-${i}`)]) {
    const n = createHash("sha256").update(id).digest().readUInt32BE(0) % 64;
    expect(recallGuardPath("/owned", id)).toBe(`/owned/.recall-guard-${n.toString(16).padStart(2, "0")}.sqlite`);
  }
  expect(new Set(Array.from({ length: 1000 }, (_, i) => recallGuardPath("/owned", `s-${i}`))).size).toBe(64);
});
test("OL-3 colliding sessions fail open; non-colliding sessions proceed; release allows successor", async () => {
  const { directory, deps } = fixture(); await runHook(input, deps);
  let collision = "", distinct = "";
  for (let i = 0; i < 2048 && (!collision || !distinct); i++) {
    const id = `session-${i}`;
    if (recallGuardPath(directory, id) === recallGuardPath(directory, "fixture")) collision ||= id; else distinct ||= id;
  }
  expect(collision).not.toBe(""); expect(distinct).not.toBe("");
  const other = { ...input, session_id: distinct }; await runHook(other, deps);
  const release = acquire(directory)!; expect(release).toBeFunction();
  expect(acquire(directory, collision)).toBeUndefined();
  const legacy = await runHook(input, { ...deps, dedup: undefined });
  expect(await runHook(input, deps)).toBe(legacy);
  expect(context(await runHook(other, deps))).toBe("");
  release(); expect(acquire(directory, collision)).toBeFunction();
});
test("OL-2 predecessor cleanup repeated after successor acquisition cannot release successor", () => {
  const { directory } = fixture();
  const predecessor = acquire(directory)!; expect(predecessor).toBeFunction();
  predecessor();
  const successor = acquire(directory)!; expect(successor).toBeFunction();
  predecessor();
  expect(acquire(directory)).toBeUndefined();
  successor(); expect(acquire(directory)).toBeFunction();
});
test("OL-2 guard setup preserves cross-process exclusion", async () => {
  const { directory } = fixture(); const ready = join(directory, "ready");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/guard-holder.ts"), directory, "fixture", ready], { env: { RECALL_GUARD_FIXTURE: "owned", HOME: directory, TMPDIR: directory, PATH: "/usr/bin:/bin" }, stdout: "ignore", stderr: "pipe" }); children.push(child);
  const until = Date.now() + 5000;
  while (!existsSync(ready) && child.exitCode === null && Date.now() < until) await Bun.sleep(5);
  expect(existsSync(ready)).toBe(true); expect(child.exitCode).toBeNull();
  expect(acquire(directory)).toBeUndefined();
  child.kill("SIGKILL"); expect(await child.exited).toBe(137);
  expect(acquire(directory)).toBeFunction();
});
test("OL-2 refused same-process contender preserves holder exclusion against an external process", async () => {
  const { directory } = fixture();
  const release = acquire(directory)!; expect(release).toBeFunction();
  expect(acquire(directory)).toBeUndefined();
  const attempt = async () => {
    const ready = join(directory, `attempt-${children.length}`);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/guard-holder.ts"), directory, "fixture", ready], {
      env: { RECALL_GUARD_FIXTURE: "owned", HOME: directory, TMPDIR: directory, PATH: "/usr/bin:/bin" }, stdout: "ignore", stderr: "pipe",
    }); children.push(child);
    const until = Date.now() + 5000;
    while (!existsSync(ready) && child.exitCode === null && Date.now() < until) await Bun.sleep(5);
    if (existsSync(ready)) {
      child.kill("SIGKILL"); expect(await child.exited).toBe(137); return "acquired";
    }
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; throw Error("fixture acquisition deadline"); }
    expect(await child.exited).toBe(2); return "refused";
  };
  try { expect(await attempt()).toBe("refused"); }
  finally { release(); }
  expect(await attempt()).toBe("acquired");
});
test("OL-5 private empty rollback guard; no schema or data; release idempotent; guard never unlinked", () => {
  const { directory } = fixture(); const path = recallGuardPath(directory, "fixture");
  const release = acquire(directory)!; expect(release).toBeFunction();
  expect(statSync(path).mode & 0o777).toBe(0o600); expect(statSync(path).size).toBe(0);
  const inode = statSync(path).ino;
  expect(readdirSync(directory).every(n => [basename(path), basename(path) + "-journal"].includes(n))).toBe(true);
  release(); release(); expect(statSync(path).ino).toBe(inode); expect(readFileSync(path)).toHaveLength(0);
  const db = new Database(path, { create: false });
  try { expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" }); expect(db.query("SELECT name FROM sqlite_master").all()).toEqual([]); } finally { db.close(); }
  expect(readFileSync(path)).toHaveLength(0);
});
for (const kind of ["symlink", "directory", "nonempty", "hardlink", "readonly"] as const) {
  test(`OL-4/8 ${kind} guard fails open byte-identical to legacy`, async () => {
    const { directory, deps } = fixture(); await runHook(input, deps);
    const path = recallGuardPath(directory, "fixture"); rmSync(path, { force: true });
    const target = join(directory, "untouched"); writeFileSync(target, "sentinel");
    if (kind === "symlink") symlinkSync(target, path);
    if (kind === "directory") mkdirSync(path);
    if (kind === "nonempty") writeFileSync(path, "not sqlite");
    if (kind === "hardlink") { writeFileSync(path, ""); linkSync(path, join(directory, "alias")); }
    if (kind === "readonly") { writeFileSync(path, ""); chmodSync(path, 0o400); }
    const legacy = await runHook(input, { ...deps, dedup: undefined });
    expect(await runHook(input, deps)).toBe(legacy); expect(readFileSync(target, "utf8")).toBe("sentinel");
  });
}
test("OL-4 private mode tightened on existing writable guard", () => {
  const { directory } = fixture(); const path = recallGuardPath(directory, "fixture"); writeFileSync(path, "", { mode: 0o666 }); chmodSync(path, 0o666);
  expect(acquire(directory)).toBeFunction(); expect(statSync(path).mode & 0o777).toBe(0o600);
});
test("OL-4 symlinked or missing parent refuses without touching its target", () => {
  const { directory } = fixture(); const target = join(directory, "target"); mkdirSync(target);
  const link = join(directory, "link"); symlinkSync(target, link);
  expect(acquire(link)).toBeUndefined(); expect(readdirSync(target)).toEqual([]);
  expect(acquire(join(directory, "missing"))).toBeUndefined();
});
test("OL-7 young legacy lock untouched; aged lock keeps existing two-day prune; guards ignored", async () => {
  const { directory, deps } = fixture(); await runHook(input, deps);
  const lock = join(directory, "fixture.json.lock"); writeFileSync(lock, "legacy"); const before = statSync(lock);
  expect(await runHook(input, deps)).toBe(await runHook(input, { ...deps, dedup: undefined }));
  expect(readFileSync(lock, "utf8")).toBe("legacy"); expect(statSync(lock).ino).toBe(before.ino); expect(statSync(lock).mtimeMs).toBe(before.mtimeMs);
  const old = new Date(Date.now() - 3 * 86400000); utimesSync(lock, old, old);
  const path = recallGuardPath(directory, "fixture"), ino = statSync(path).ino; utimesSync(path, old, old);
  expect(context(await runHook(input, deps))).toBe(""); expect(existsSync(lock)).toBe(false); expect(statSync(path).ino).toBe(ino);
});
for (const mode of ["throw", "deadline", "state-failure"] as const) {
  test(`OL-6 ${mode} releases the guard for next invocation`, async () => {
    const { directory, deps } = fixture(); await runHook(input, deps);
    const next: HookDeps = { ...deps, recall: async () => [{ source: "fixture", content: "unseen candidate" }], dedup: { directory, deadlineMs: 10, decision: async () => {
      if (mode === "throw") throw Error("fixture");
      if (mode === "deadline") return new Promise(() => {});
      rmSync(join(directory, "fixture.json")); mkdirSync(join(directory, "fixture.json")); return [false];
    } } };
    const out = await runHook(input, next);
    if (mode === "state-failure") expect(out).toBe(await runHook(input, { ...next, dedup: undefined }));
    else expect(context(out)).toContain("unseen candidate");
    const release = acquire(directory); expect(release).toBeFunction();
    expect(readdirSync(directory).filter(n => n.endsWith(".tmp"))).toEqual([]);
  });
}

test("OL-4 nonempty valid SQLite guard refuses without using or changing fixture data", async () => {
  const { directory, deps } = fixture(); await runHook(input, deps);
  const path = recallGuardPath(directory, "fixture");
  const db = new Database(path); try { db.exec("CREATE TABLE fixture_only(value TEXT); INSERT INTO fixture_only VALUES ('owned fixture')"); } finally { db.close(); }
  const before = readFileSync(path);
  expect(acquire(directory)).toBeUndefined();
  expect(await runHook(input, deps)).toBe(await runHook(input, { ...deps, dedup: undefined }));
  expect(readFileSync(path)).toEqual(before);
});
test("OL-6 release closes its private connection once; repeated release does not close another", () => {
  const { directory } = fixture(); const close = spyOn(Database.prototype, "close");
  try {
    const release = acquire(directory)!; expect(release).toBeFunction(); expect(close).toHaveBeenCalledTimes(0);
    release(); expect(close).toHaveBeenCalledTimes(1); release(); expect(close).toHaveBeenCalledTimes(1);
  } finally { close.mockRestore(); }
});

test("OL-3 guard and live rollback journal ignored by old state pruning", async () => {
  const { directory, deps } = fixture(); const path = recallGuardPath(directory, "fixture");
  const release = acquire(directory)!; expect(release).toBeFunction();
  const journal = path + "-journal"; expect(existsSync(journal)).toBe(true);
  const old = new Date(Date.now() - 3 * 86400000); utimesSync(path, old, old); utimesSync(journal, old, old);
  const guardInode = statSync(path).ino, journalInode = statSync(journal).ino;
  let other = ""; for (let i = 0; i < 2048 && !other; i++) if (recallGuardPath(directory, `other-${i}`) !== path) other = `other-${i}`;
  expect(other).not.toBe(""); expect(context(await runHook({ ...input, session_id: other }, deps))).toContain("compiler boundaries");
  expect(statSync(path).ino).toBe(guardInode); expect(statSync(journal).ino).toBe(journalInode);
  expect(statSync(journal).mode & 0o777).toBe(0o600); release();
});
