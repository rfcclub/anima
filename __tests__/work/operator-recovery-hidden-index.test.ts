import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatbeltTest } from "../helpers/seatbelt";
import { loadWorkConfig } from "../../src/work/config";
import { gitInTree } from "../../src/work/production";
import { createStopRecorder } from "../../src/work/stops";
import { WorkStore } from "../../src/work/store";
import { prepareWorkspace } from "../../src/work/workspace";

seatbeltTest.each(["--assume-unchanged", "--skip-worktree"])(
  "recovery refuses a tracked change hidden by Git index flag %s",
  async (flag) => {
    const root = mkdtempSync(join(tmpdir(), "recover-index-"));
    const dbPath = join(root, "work.db");
    const source = join(root, "source");
    mkdirSync(source);
    function git(cwd: string, ...args: string[]): string {
      const p = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
        cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
      if (p.exitCode !== 0) throw new Error(p.stderr.toString());
      return p.stdout.toString().trim();
    }
    const store = WorkStore.open(dbPath, { rootBase: root });
    try {
      git(source, "init", "-q", "-b", "main");
      writeFileSync(join(source, "tracked.txt"), "first\n");
      git(source, "add", ".");
      git(source, "commit", "-qm", "base");
      const base = git(source, "rev-parse", "HEAD");
      const work = store.createWork({
        repo: "test/repo", issue: 7, approvedDigest: "a".repeat(12), workId: "wflags259",
        config: loadWorkConfig({ caps: { maxSessions: 1 } }),
      }).work;
      const ws = await prepareWorkspace({ root: work.root, source, branch: work.branch });
      const reservation = store.reserveSession(work.workId, { jobId: "job", claimId: "claim" });
      if (!reservation.ok) throw new Error("reservation failed");
      store.closeSession(reservation.session.sessionId, { stopCause: "max_reached", iterations: 2, execMs: 1000 });
      const stop = createStopRecorder({ store, read: gitInTree })({
        work, session: store.getSession(reservation.session.sessionId)!, adapter: "loop", stopCause: "max_reached",
        cessation: "proven", leaseHeld: true, generationCurrent: true,
      });
      expect([stop.trusted, stop.status]).toEqual([true, ""]);
      store.setState(work.workId, "blocked", "sessions exhausted");
      git(ws.tree, "update-index", flag, "tracked.txt");
      writeFileSync(join(ws.tree, "tracked.txt"), "tampered\n");
      expect(git(ws.tree, "status", "--porcelain", "--untracked-files=all")).toBe("");
      const p = Bun.spawnSync({
        cmd: ["bun", "src/cli.ts", "work", "recover", work.workId, "--base", base, "--caps", "maxSessions=2"],
        env: { ...process.env, ANIMA_WORK_DB: dbPath, ANIMA_WORK_ROOT: root, NODE_ENV: "test" },
      });
      expect(p.exitCode).not.toBe(0);
      expect(p.stderr.toString()).toMatch(/index|hidden|flag/i);
      expect(store.getWork(work.workId)!.state).toBe("blocked");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
