import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { seatbeltTest } from "../helpers/seatbelt";
import { loadWorkConfig } from "../../src/work/config";
import { gitInTree } from "../../src/work/production";
import { createStopRecorder } from "../../src/work/stops";
import { WorkStore } from "../../src/work/store";
import { prepareWorkspace } from "../../src/work/workspace";

seatbeltTest.each([
  "valid", "valid-two", "unrelated", "graft", "corrupt-commit", "missing-pr", "missing-pr-number", "wrong-pr", "wrong-branch", "detached", "moved-head", "dirty", "unproven",
] as const)("recovery with a worker commit ahead of the original base: %s", async (kind) => {
  const root = mkdtempSync(join(tmpdir(), "work-recover-descendant-"));
  const source = join(root, "source");
  const dbPath = join(root, "work.db");
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
    writeFileSync(join(source, "tracked.txt"), "base\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "base");
    const base = git(source, "rev-parse", "HEAD");
    const work = store.createWork({
      repo: "test/repo", issue: 7, approvedDigest: "a".repeat(12), workId: "wdesc259",
      config: loadWorkConfig({ caps: { maxSessions: 1 } }),
    }).work;
    const ws = await prepareWorkspace({ root: work.root, source, branch: work.branch });
    writeFileSync(join(ws.tree, "tracked.txt"), "worker change\n");
    git(ws.tree, "add", "tracked.txt");
    git(ws.tree, "commit", "-qm", "worker change");
    if (kind === "valid-two") {
      writeFileSync(join(ws.tree, "tracked.txt"), "second worker change\n");
      git(ws.tree, "add", "tracked.txt");
      git(ws.tree, "commit", "-qm", "second worker change");
    }
    if (kind === "unrelated" || kind === "graft" || kind === "corrupt-commit") {
      const tree = git(ws.tree, "rev-parse", "HEAD^{tree}");
      const unrelated = git(ws.tree, "commit-tree", tree, "-m", "unrelated history");
      git(ws.tree, "reset", "--hard", unrelated);
    }
    const head = git(ws.tree, "rev-parse", "HEAD");
    if (kind !== "missing-pr") {
      store.recordPullRequest(work.workId, { number: 1, head: kind === "wrong-pr" ? base : head, url: "https://github.com/test/repo/pull/1" });
    }
    if (kind === "missing-pr-number") {
      const db = new Database(dbPath);
      db.run("UPDATE works SET pr_number = NULL WHERE work_id = ?", [work.workId]);
      db.close();
    }
    const reservation = store.reserveSession(work.workId, { jobId: "job", claimId: "claim" });
    if (!reservation.ok) throw new Error("reservation failed");
    store.closeSession(reservation.session.sessionId, { stopCause: "done", iterations: 2, execMs: 1000 });
    const stop = createStopRecorder({ store, read: gitInTree })({
      work, session: store.getSession(reservation.session.sessionId)!, adapter: "loop", stopCause: "done",
      cessation: kind === "unproven" ? "unproven" : "proven", leaseHeld: true, generationCurrent: true,
    });
    if (kind === "unproven") {
      expect(stop.trusted).toBe(false);
    } else {
      expect(stop.head).toBe(head);
      expect(stop.status).toBe("");
    }
    store.setState(work.workId, "blocked", "operator recovery required");
    if (kind === "graft") {
      writeFileSync(join(ws.gitDir, "info", "grafts"), `${head} ${base}\n`);
      // A normal ancestor check trusts the worker-writable graft file.
      git(ws.tree, "merge-base", "--is-ancestor", base, head);
    }
    if (kind === "corrupt-commit") {
      const original = Bun.spawnSync(["git", "cat-file", "commit", head], { cwd: ws.tree });
      if (original.exitCode !== 0) throw new Error(original.stderr.toString());
      const contents = original.stdout.toString().replace("\n", `\nparent ${base}\n`);
      const object = join(ws.gitDir, "objects", head.slice(0, 2), head.slice(2));
      chmodSync(object, 0o600);
      writeFileSync(object, deflateSync(Buffer.concat([Buffer.from(`commit ${Buffer.byteLength(contents)}\0`), Buffer.from(contents)])));
      // Git rejects a forged loose commit when it reads the object's hash.
      const check = Bun.spawnSync(["git", "-c", "core.commitGraph=false", "merge-base", "--is-ancestor", base, head], { cwd: ws.tree });
      expect(check.exitCode).not.toBe(0);
    }
    if (kind === "wrong-branch") git(ws.tree, "switch", "-qc", "different-branch");
    if (kind === "detached") git(ws.tree, "checkout", "--detach", "-q", head);
    if (kind === "moved-head") {
      writeFileSync(join(ws.tree, "tracked.txt"), "new commit after stop\n");
      git(ws.tree, "add", "tracked.txt");
      git(ws.tree, "commit", "-qm", "after stop");
    }
    if (kind === "dirty") writeFileSync(join(ws.tree, "tracked.txt"), "dirty after stop\n");
    const before = store.getWork(work.workId);
    const events = store.listEvents(work.workId);
    const p = Bun.spawnSync({
      cmd: ["bun", "src/cli.ts", "work", "recover", work.workId, "--base", base, "--caps", "maxSessions=2"],
      env: { ...process.env, ANIMA_WORK_DB: dbPath, ANIMA_WORK_ROOT: root, NODE_ENV: "test" },
    });
    if (kind === "valid" || kind === "valid-two") {
      expect({ exit: p.exitCode, stderr: p.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
      const after = store.getWork(work.workId)!;
      expect(after.state).toBe("checkpointed");
      expect([after.sessionsUsed, after.iterationsUsed, after.execMsUsed, after.generation])
        .toEqual([before!.sessionsUsed, before!.iterationsUsed, before!.execMsUsed, before!.generation]);
      const recoveryEvents = store.listEvents(work.workId).filter((event) => event.kind === "operator-recovery");
      expect(recoveryEvents).toHaveLength(1);
      expect(recoveryEvents[0]!.detail).toMatchObject({ base });
      return;
    }
    expect(p.exitCode).not.toBe(0);
    const expected: Record<Exclude<typeof kind, "valid" | "valid-two">, RegExp> = {
      unrelated: /ancestor|descendant/i,
      graft: /graft|history|ancestor|descendant/i,
      "corrupt-commit": /corrupt|integrity|history|ancestor|descendant/i,
      "missing-pr": /pull request|pr head/i,
      "missing-pr-number": /pull request|pr head/i,
      "wrong-pr": /pull request|pr head/i,
      "wrong-branch": /branch/i,
      detached: /branch/i,
      "moved-head": /head|checkpoint/i,
      dirty: /contents|dirty|checkpoint/i,
      unproven: /untrusted|unproven|cessation/i,
    };
    expect(p.stderr.toString()).toMatch(expected[kind]);
    expect(store.getWork(work.workId)).toEqual(before);
    expect(store.listEvents(work.workId)).toEqual(events);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
