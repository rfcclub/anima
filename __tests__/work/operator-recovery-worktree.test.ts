import { expect } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { seatbeltTest } from "../helpers/seatbelt";
import { loadWorkConfig } from "../../src/work/config";
import { gitInTree } from "../../src/work/production";
import { createStopRecorder } from "../../src/work/stops";
import { WorkStore } from "../../src/work/store";
import { prepareWorkspace } from "../../src/work/workspace";

seatbeltTest.each(["clean", "worktree", "gitdir", "filter", "filter-clean", "stat", "ignored", "replace", "object", "missing-base", "wrong-base", "commit-ahead"] as const)(
  "recovery checks Git %s and preserves the ledger on refusal",
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "recover-redirect-"));
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
      mkdirSync(join(source, "nested"));
      writeFileSync(join(source, "nested", "space and\nnewline.bin"), Buffer.from([0, 1, 255]));
      writeFileSync(join(source, "executable"), "#!/bin/sh\n");
      chmodSync(join(source, "executable"), 0o755);
      symlinkSync("tracked.txt", join(source, "link"));
      git(source, "add", ".");
      git(source, "commit", "-qm", "base");
      const base = git(source, "rev-parse", "HEAD");
      const work = store.createWork({
        repo: "test/repo", issue: 7, approvedDigest: "a".repeat(12), workId: "wredirect259",
        config: loadWorkConfig({ caps: { maxSessions: 1 } }),
      }).work;
      const ws = await prepareWorkspace({ root: work.root, source, branch: work.branch });
      if (kind === "commit-ahead") {
        writeFileSync(join(ws.tree, "tracked.txt"), "committed work\n");
        git(ws.tree, "add", "tracked.txt");
        git(ws.tree, "commit", "-qm", "work ahead of base");
      }
      const reservation = store.reserveSession(work.workId, { jobId: "job", claimId: "claim" });
      if (!reservation.ok) throw new Error("reservation failed");
      store.closeSession(reservation.session.sessionId, { stopCause: "max_reached", iterations: 2, execMs: 1000 });
      const stop = createStopRecorder({ store, read: gitInTree })({
        work, session: store.getSession(reservation.session.sessionId)!, adapter: "loop", stopCause: "max_reached",
        cessation: "proven", leaseHeld: true, generationCurrent: true,
      });
      expect([stop.trusted, stop.status]).toEqual([true, ""]);
      store.setState(work.workId, "blocked", "sessions exhausted");
      const before = store.getWork(work.workId);
      const events = store.listEvents(work.workId);
      if (kind === "clean" || kind === "missing-base" || kind === "wrong-base" || kind === "commit-ahead") {
        // An unchanged tree with binary, executable, symlink and unusual paths remains recoverable.
      } else if (kind === "worktree") {
        const decoy = join(work.root, "decoy");
        cpSync(ws.tree, decoy, { recursive: true, verbatimSymlinks: true });
        git(ws.tree, "config", "core.worktree", decoy);
        writeFileSync(join(ws.tree, "tracked.txt"), "tampered\n");
        expect(git(ws.tree, "status", "--porcelain", "--untracked-files=all")).toBe("");
      } else if (kind === "gitdir") {
        const decoy = join(work.root, "decoy-git");
        cpSync(ws.gitDir, decoy, { recursive: true });
        writeFileSync(join(ws.tree, ".git"), `gitdir: ${decoy}\n`);
        expect(realpathSync(git(ws.tree, "rev-parse", "--absolute-git-dir"))).toBe(realpathSync(decoy));
      } else if (kind === "filter" || kind === "filter-clean") {
        writeFileSync(join(ws.gitDir, "info", "attributes"), "tracked.txt filter=mislead\n");
        git(ws.tree, "config", "filter.mislead.clean", "printf 'first\\n'");
        if (kind === "filter") writeFileSync(join(ws.tree, "tracked.txt"), "other\n");
        expect(git(ws.tree, "status", "--porcelain", "--untracked-files=all")).toBe("");
      } else if (kind === "stat") {
        git(ws.tree, "config", "core.trustctime", "false");
        git(ws.tree, "config", "core.checkStat", "minimal");
        const path = join(ws.tree, "tracked.txt");
        const oldTime = new Date(Date.now() - 60_000);
        utimesSync(path, oldTime, oldTime);
        git(ws.tree, "status", "--porcelain");
        const beforeStat = statSync(path);
        writeFileSync(path, "other\n");
        utimesSync(path, beforeStat.atime, beforeStat.mtime);
        expect(git(ws.tree, "status", "--porcelain", "--untracked-files=all")).toBe("");
      } else if (kind === "replace") {
        writeFileSync(join(ws.tree, "tracked.txt"), "other\n");
        git(ws.tree, "add", "tracked.txt");
        git(ws.tree, "commit", "-qm", "replacement");
        const replacement = git(ws.tree, "rev-parse", "HEAD");
        git(ws.tree, "replace", base, replacement);
        git(ws.tree, "update-ref", `refs/heads/${work.branch}`, base, replacement);
        expect(git(ws.tree, "rev-parse", "HEAD")).toBe(base);
        expect(git(ws.tree, "status", "--porcelain", "--untracked-files=all")).toBe("");
      } else if (kind === "object") {
        writeFileSync(join(ws.tree, "tracked.txt"), "other\n");
        git(ws.tree, "add", "tracked.txt");
        const blob = git(ws.tree, "hash-object", "--no-filters", "tracked.txt");
        const treeOid = git(ws.tree, "rev-parse", `${base}^{tree}`);
        const treeResult = Bun.spawnSync(["git", "cat-file", "tree", treeOid], { cwd: ws.tree });
        if (treeResult.exitCode !== 0) throw new Error(treeResult.stderr.toString());
        const content = Buffer.from(treeResult.stdout);
        const marker = Buffer.from("100644 tracked.txt\0");
        const offset = content.indexOf(marker);
        if (offset < 0) throw new Error("tracked entry not found");
        Buffer.from(blob, "hex").copy(content, offset + marker.length);
        const path = join(ws.gitDir, "objects", treeOid.slice(0, 2), treeOid.slice(2));
        chmodSync(path, 0o600);
        writeFileSync(path, deflateSync(Buffer.concat([Buffer.from(`tree ${content.length}\0`), content])));
        expect(git(ws.tree, "rev-parse", "HEAD")).toBe(base);
      } else {
        writeFileSync(join(ws.gitDir, "info", "exclude"), "ignored.txt\n");
        writeFileSync(join(ws.tree, "ignored.txt"), "untracked work\n");
        expect(git(ws.tree, "status", "--porcelain", "--untracked-files=all")).toBe("");
      }
      const p = Bun.spawnSync({
        cmd: [
          "bun", "src/cli.ts", "work", "recover", work.workId, "--caps", "maxSessions=2",
          ...(kind === "missing-base" ? [] : ["--base", kind === "wrong-base" ? "a".repeat(40) : base]),
        ],
        env: { ...process.env, ANIMA_WORK_DB: dbPath, ANIMA_WORK_ROOT: root, NODE_ENV: "test" },
      });
      if (kind === "clean") {
        expect({ exit: p.exitCode, stderr: p.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
        expect(store.getWork(work.workId)!.state).toBe("checkpointed");
        return;
      }
      expect(p.exitCode).not.toBe(0);
      if (kind === "missing-base") expect(p.stderr.toString()).toMatch(/base/i);
      if (kind === "wrong-base") expect(p.stderr.toString()).toMatch(/base.*checkpoint|checkpoint.*base/i);
      if (kind === "commit-ahead") expect(p.stderr.toString()).toMatch(/PR head/i);
      expect(store.getWork(work.workId)).toEqual(before);
      expect(store.listEvents(work.workId)).toEqual(events);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
