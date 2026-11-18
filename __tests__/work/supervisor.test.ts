/**
 * castle-work-loop, WL-3/WL-10: process-group supervision, proven cessation,
 * the exclusive workspace lock and the generation fence. Real short-lived child processes.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireWorkLock, assertCurrentGeneration, spawnSession, StaleGenerationError, type SessionHandle,
} from "../../src/work/supervisor";
import { WorkStore } from "../../src/work/store";
import { loadWorkConfig } from "../../src/work/config";

let root: string;
let tree: string;
const handles: SessionHandle[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "work-sup-")));
  tree = join(root, "tree");
  mkdirSync(tree);
});
afterEach(async () => {
  for (const h of handles.splice(0)) await h.stopAndProve({ graceMs: 100 });
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const pgidOf = (pid: number) => Number(Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]).stdout.toString().trim());
const start = (script: string, extra: Partial<Parameters<typeof spawnSession>[0]> = {}) => {
  const h = spawnSession({ argv: ["sh", "-c", script], cwd: tree, env: { PATH: process.env.PATH ?? "" }, root, ...extra });
  handles.push(h);
  return h;
};

describe("process group", () => {
  test("a session runs in its own process group, not the supervisor's", async () => {
    const h = start("sleep 30");
    await Bun.sleep(100);
    expect(h.pgid).toBe(h.pid);
    expect(pgidOf(h.pid)).toBe(h.pid);
    expect(pgidOf(process.pid)).not.toBe(h.pid);
  });

  test("the deadline stops the session and reports it timed out", async () => {
    // Force the leader to exit before its TERM-resistant child, exposing the
    // distinction between leader exit and asynchronous group cessation.
    const h = start(`sh -c 'trap "" TERM; echo ready > ready; while :; do sleep 1; done' & wait`, { deadlineMs: 500 });
    const done = await h.exited;
    expect(done.timedOut).toBe(true);
    expect(existsSync(join(tree, "ready"))).toBe(true);
    // exited reports the leader only. Observe automatic escalation without
    // sending a second stop signal that could hide a broken deadline path.
    const cessationDeadline = Date.now() + 4500;
    while (groupAlive(h.pgid) && Date.now() < cessationDeadline) await Bun.sleep(20);
    expect(groupAlive(h.pgid)).toBe(false);
    expect((await h.stopAndProve({ graceMs: 100 })).proven).toBe(true);
  }, 10_000);
});

describe("stopAndProve", () => {
  test("kills a child and a grandchild that keeps writing, and nothing changes in the tree afterwards", async () => {
    const h = start("(while true; do echo x >> w.txt; sleep 0.05; done) & while true; do sleep 1; done");
    await Bun.sleep(300);
    expect(existsSync(join(tree, "w.txt"))).toBe(true);
    const r = await h.stopAndProve({ graceMs: 200 });
    expect(r.proven).toBe(true);
    expect(groupAlive(h.pgid)).toBe(false);
    const size = statSync(join(tree, "w.txt")).size;
    await Bun.sleep(300);
    expect(statSync(join(tree, "w.txt")).size).toBe(size);
  });

  test("a child that ignores SIGTERM is killed after the grace period", async () => {
    const h = start('trap "" TERM; while true; do sleep 1; done');
    await Bun.sleep(150);
    const t0 = Date.now();
    const r = await h.stopAndProve({ graceMs: 300 });
    expect(r.proven).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(alive(h.pid)).toBe(false);
  });

  test("stopping twice is harmless", async () => {
    const h = start("sleep 30");
    await Bun.sleep(100);
    expect((await h.stopAndProve({ graceMs: 100 })).proven).toBe(true);
    expect((await h.stopAndProve({ graceMs: 100 })).proven).toBe(true);
  });

  test("a process that left the group by starting its own session is found by working directory and killed", async () => {
    const marker = join(root, "escaped.pid");
    const h = start(`perl -e 'use POSIX; my $p=fork(); if($p==0){ POSIX::setsid(); open(F,">${marker}"); print F $$; close F; sleep 30; exit 0 } exit 0'; sleep 30`);
    for (let i = 0; i < 40 && !existsSync(marker); i++) await Bun.sleep(50);
    const escaped = Number(readFileSync(marker, "utf-8"));
    expect(alive(escaped)).toBe(true);
    expect(pgidOf(escaped)).not.toBe(h.pgid);
    const r = await h.stopAndProve({ graceMs: 200 });
    expect(r.proven).toBe(true);
    expect(r.swept).toContain(escaped);
    await Bun.sleep(100);
    expect(alive(escaped)).toBe(false);
  });

  test("when a straggler cannot be killed the result is unproven and names it, so the work can be blocked", async () => {
    const marker = join(root, "stuck.pid");
    const h = start(`perl -e 'use POSIX; my $p=fork(); if($p==0){ POSIX::setsid(); open(F,">${marker}"); print F $$; close F; sleep 30; exit 0 } exit 0'; sleep 30`);
    for (let i = 0; i < 40 && !existsSync(marker); i++) await Bun.sleep(50);
    const stuck = Number(readFileSync(marker, "utf-8"));
    const r = await h.stopAndProve({ graceMs: 100, signal: (target, sig) => { if (target !== stuck && target !== -stuck) process.kill(target, sig); } });
    expect(r.proven).toBe(false);
    expect(r.reason).toBe("cessation-unproven");
    expect(r.survivors).toContain(stuck);
    process.kill(stuck, "SIGKILL"); // test cleanup
  });
});

describe("workspace lock", () => {
  test("a second holder is refused while the first holds it, and succeeds after release", () => {
    const first = acquireWorkLock(root);
    expect(first).not.toBeNull();
    expect(acquireWorkLock(root)).toBeNull();
    first!.release();
    const again = acquireWorkLock(root);
    expect(again).not.toBeNull();
    again!.release();
  });

  test("a lock left by a process that no longer exists is taken over", () => {
    writeFileSync(join(root, ".work.lock"), "2147483000\n");
    const lock = acquireWorkLock(root);
    expect(lock).not.toBeNull();
    lock!.release();
  });

  test("release is idempotent", () => {
    const lock = acquireWorkLock(root)!;
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });
});

describe("generation fence", () => {
  test("the current generation passes and an older one is rejected", () => {
    const store = WorkStore.open(":memory:", { rootBase: root });
    const w = store.createWork({ repo: "a/x", issue: 1, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({}) }).work;
    const r1 = store.reserveSession(w.workId, { jobId: "j", claimId: "c1" });
    expect(r1.ok).toBe(true);
    const gen1 = r1.ok ? r1.session.generation : -1;
    expect(() => assertCurrentGeneration(store, w.workId, gen1)).not.toThrow();
    if (r1.ok) store.closeSession(r1.session.sessionId, { iterations: 1, execMs: 1, stopCause: "max_reached" });
    const r2 = store.reserveSession(w.workId, { jobId: "j", claimId: "c2" });
    expect(r2.ok).toBe(true);
    expect(() => assertCurrentGeneration(store, w.workId, gen1)).toThrow(StaleGenerationError);
    store.close();
  });

  test("an unknown work is rejected", () => {
    const store = WorkStore.open(":memory:", { rootBase: root });
    expect(() => assertCurrentGeneration(store, "nope", 1)).toThrow(StaleGenerationError);
    store.close();
  });
});
