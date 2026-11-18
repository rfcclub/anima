import { expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatbeltTest } from "../helpers/seatbelt";
import { loadWorkConfig } from "../../src/work/config";
import { gitInTree } from "../../src/work/production";
import { createStopRecorder } from "../../src/work/stops";
import { WorkStore } from "../../src/work/store";
import { prepareWorkspace } from "../../src/work/workspace";

seatbeltTest("recovery CLI refuses a hostile Git filter without running it", async () => {
  const root = mkdtempSync(join(tmpdir(), "recover-cli-real-"));
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
    writeFileSync(join(source, "tracked.txt"), "same content\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "base");
    const base = git(source, "rev-parse", "HEAD");
    const work = store.createWork({
      repo: "test/repo", issue: 7, approvedDigest: "a".repeat(12), workId: "wcli259",
      config: loadWorkConfig({ caps: { maxSessions: 1 } }),
    }).work;
    const ws = await prepareWorkspace({ root: work.root, source, branch: work.branch });
    const reservation = store.reserveSession(work.workId, { jobId: "job", claimId: "claim" });
    if (!reservation.ok) throw new Error("reservation failed");
    store.closeSession(reservation.session.sessionId, { stopCause: "max_reached", iterations: 2, execMs: 1000 });
    const session = store.getSession(reservation.session.sessionId)!;
    const stop = createStopRecorder({ store, read: gitInTree })({
      work, session, adapter: "loop", stopCause: "max_reached", cessation: "proven",
      leaseHeld: true, generationCurrent: true,
    });
    expect(stop.trusted).toBe(true);
    expect(stop.status).toBe("");
    store.setState(work.workId, "blocked", "sessions exhausted");

    // Recovery does not need to execute repository-controlled clean filters.
    const marker = join(root, "outside-filter-marker");
    git(ws.tree, "config", "filter.probe.clean", `sh -c 'echo escaped > ${marker}; cat'`);
    mkdirSync(join(ws.gitDir, "info"), { recursive: true });
    writeFileSync(join(ws.gitDir, "info", "attributes"), "tracked.txt filter=probe\n");
    writeFileSync(join(ws.tree, "tracked.txt"), "same content\n");
    const p = Bun.spawnSync({
      cmd: ["bun", "src/cli.ts", "work", "recover", work.workId, "--base", base, "--caps", "maxSessions=2"],
      env: { ...process.env, ANIMA_WORK_DB: dbPath, ANIMA_WORK_ROOT: root, NODE_ENV: "test" },
    });
    expect(p.exitCode).not.toBe(0);
    expect(p.stderr.toString()).toMatch(/filter/i);
    expect(store.getWork(work.workId)!.state).toBe("blocked");
    expect(existsSync(marker)).toBe(false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
