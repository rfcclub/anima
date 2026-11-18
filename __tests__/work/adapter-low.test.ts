import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMeshJobsConfig } from "../../src/mesh-jobs/config";
import { loadWorkConfig } from "../../src/work/config";
import { createSessionExecutor } from "../../src/work/executor";
import { createWorkHandler } from "../../src/work/consumer";
import { issueDigest12 } from "../../src/work/approval";
import { WorkStore } from "../../src/work/store";

const workerInput = (root: string, signal: AbortSignal, deadlineMs = 1000) => {
  const work = {
    workId: "wabc1234ef0", root, branch: "work/7-wabc1234ef0",
    issue: 7, generation: 1, provider: "test", model: "test-model",
  };
  return {
    work, session: { sessionId: "session-1", no: 1, generation: 1 },
    claim: { id: "claim-1", jobId: "job-1" }, kind: "start-work",
    maxIterations: 5, deadlineMs, signal,
    workspace: {
      root, tree: join(root, "tree"), gitDir: join(root, "git"),
      tmp: join(root, "tmp"), home: join(root, "home"),
      branch: work.branch, created: false,
    },
  } as const;
};

const provider = {
  name: "test",
  async query() { return { message: { role: "assistant" as const, content: "ok" } }; },
};

const post = (url: string, token: string) => fetch(`${url}/v1/chat/completions`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hello" }] }),
});

const adapterDeps = (input: ReturnType<typeof workerInput>, runner: unknown) => ({
  store: { getWork: () => input.work },
  runner,
  createProvider: async () => provider,
  buildTask: async () => "task",
  treeGit: (_tree: string, args: string[]) =>
    args.includes("symbolic-ref") ? `refs/heads/${input.work.branch}` : args.includes("rev-parse") ? "a".repeat(40) : "",
  author: () => ({ name: "test", email: "test@example.invalid" }),
  killGraceMs: 100,
}) as never;

describe("low adapter (cartridge-worker-dispatch S7)", () => {
  test("runner start rejection returns a worker error with unproven cessation", async () => {
    const { createLowAdapter } = await import("../../src/work/adapter-low");
    const root = mkdtempSync(join(tmpdir(), "low-start-rejected-"));
    try {
      const input = workerInput(root, new AbortController().signal);
      const runner = { start: async () => { throw new Error("image unavailable"); } };
      const result = await createLowAdapter(adapterDeps(input, runner)).run(input as never);
      expect(result.stopCause).toBe("worker_error");
      expect(result.cessation).toBe("unproven");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("external-adapter-off-by-default", async () => {
    expect(loadWorkConfig({}).externalAdapter).toBe("off");
    expect(loadWorkConfig({ externalAdapter: "low" }).externalAdapter).toBe("low");
    expect(() => loadWorkConfig({ externalAdapter: "unknown" } as never)).toThrow(RangeError);
    expect(() => loadWorkConfig({ externalAdapter: null } as never)).toThrow(RangeError);
    expect(createSessionExecutor({} as never).adapterKind).toBe("loop");
    const production = await import("../../src/work/production");
    expect(typeof production.selectWorkAdapter).toBe("function");
    let constructed = 0;
    const factory = () => { constructed++; return { kind: "low", run: async () => ({ stopCause: "done" as const, iterations: 0, cessation: "proven" as const }) }; };
    expect(production.selectWorkAdapter("off", factory)).toBeUndefined();
    expect(constructed).toBe(0);
    expect(production.selectWorkAdapter("low", factory)?.kind).toBe("low");
    expect(constructed).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), "low-config-"));
    const path = join(dir, "mesh-jobs.json");
    const write = (externalAdapter?: unknown) => {
      writeFileSync(path, JSON.stringify({
        gatewayUrl: "http://127.0.0.1:1526",
        workers: [{ agent: "finn" }],
        work: {
          enabled: true, author: "finn", authorActor: "finn-bot",
          authorMeshId: "finn@host", enqueuer: "bruno", base: "master",
          reviewers: [{ agent: "cleo", meshId: "cleo@host", login: "cleo-bot" }],
          ...(externalAdapter === undefined ? {} : { externalAdapter }),
        },
      }));
      chmodSync(path, 0o600);
    };
    try {
      write();
      expect(loadMeshJobsConfig(path)!.work!.externalAdapter ?? "off").toBe("off");
      write("low");
      expect(loadMeshJobsConfig(path)!.work!.externalAdapter).toBe("low");
      write("unknown");
      expect(() => loadMeshJobsConfig(path)).toThrow("work.externalAdapter");
      write(null);
      expect(() => loadMeshJobsConfig(path)).toThrow("work.externalAdapter");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("low-exit-codes", async () => {
    const { createLowAdapter, lowStopCause } = await import("../../src/work/adapter-low");
    expect([0, 1, 3, 4, 5, 2, null].map(lowStopCause)).toEqual([
      "done", "unverified", "provider_error", "question", "max_reached", "worker_error", "worker_error",
    ]);
    const root = mkdtempSync(join(tmpdir(), "low-exits-"));
    try {
      for (const [code, cause] of [[0, "done"], [1, "unverified"], [3, "provider_error"], [4, "question"], [5, "max_reached"], [2, "worker_error"], [null, "worker_error"]] as const) {
        const input = workerInput(root, new AbortController().signal);
        const runner = { start: async ({ gatewayUrl, gatewayToken }: { gatewayUrl: string; gatewayToken: string }) => {
          expect((await post(gatewayUrl, gatewayToken)).status).toBe(200);
          expect((await post(gatewayUrl, gatewayToken)).status).toBe(200);
          return { exited: Promise.resolve({ code }), kill: async () => {}, gone: async () => true, output: async () => "" };
        } };
        const result = await createLowAdapter(adapterDeps(input, runner)).run(input as never);
        expect([result.stopCause, result.iterations, result.cessation]).toEqual([cause, 2, "proven"]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("low-deadline-and-abort", async () => {
    const { createLowAdapter } = await import("../../src/work/adapter-low");
    const root = mkdtempSync(join(tmpdir(), "low-stop-"));
    try {
      for (const mode of ["deadline", "abort", "not-gone"] as const) {
        const controller = new AbortController();
        const input = workerInput(root, controller.signal, mode === "deadline" ? 30 : 1000);
        let revokedBeforeKill = false;
        let signalStarted!: () => void;
        const started = new Promise<void>((resolve) => { signalStarted = resolve; });
        const runner = { start: async ({ gatewayUrl, gatewayToken }: { gatewayUrl: string; gatewayToken: string }) => {
          let finish!: (result: { code: number | null }) => void;
          const exited = new Promise<{ code: number | null }>((resolve) => { finish = resolve; });
          signalStarted();
          return {
            exited,
            kill: async () => {
              revokedBeforeKill = (await post(gatewayUrl, gatewayToken)).status === 401;
              finish({ code: null });
            },
            gone: async () => mode !== "not-gone",
            output: async () => "",
          };
        } };
        const resultPromise = createLowAdapter(adapterDeps(input, runner)).run(input as never);
        await started;
        if (mode !== "deadline") controller.abort();
        const result = await Promise.race([resultPromise, Bun.sleep(300).then(() => null)]);
        expect(result).not.toBeNull();
        if (!result) return;
        expect(revokedBeforeKill).toBe(true);
        expect(result.stopCause).toBe(mode === "deadline" ? "deadline" : "interrupted");
        expect(result.cessation).toBe(mode === "not-gone" ? "unproven" : "proven");
        if (mode === "not-gone") expect(result.cessationCheck).toBe("vm-not-gone");
      }
      // Provider setup and work-order construction are part of the same wall-time budget.
      for (const stage of ["provider", "task"] as const) {
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let starts = 0;
        const input = workerInput(root, new AbortController().signal, 30);
        const runner = { start: async () => {
          starts++;
          return { exited: Promise.resolve({ code: 0 }), kill: async () => {}, gone: async () => true, output: async () => "" };
        } };
        const deps = {
          ...adapterDeps(input, runner) as object,
          createProvider: async () => { if (stage === "provider") await held; return provider; },
          buildTask: async () => { if (stage === "task") await held; return "task"; },
        };
        const pending = createLowAdapter(deps as never).run(input as never);
        const stopped = await Promise.race([pending, Bun.sleep(200).then(() => null)]);
        release();
        if (!stopped) await pending;
        expect(stopped?.stopCause).toBe("deadline");
        expect(stopped?.cessation).toBe("proven");
        expect(starts).toBe(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("late VM start cleans up after deadline", async () => {
    const { createLowAdapter } = await import("../../src/work/adapter-low");
    const { existsSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "low-late-start-"));
    try {
      for (const killFails of [false, true]) {
        const privateSession = join(root, `private-${killFails}`);
        mkdirSync(privateSession);
        writeFileSync(join(privateSession, "provider-token"), "session-token");
        let release!: (vm: unknown) => void;
        let started!: () => void;
        let cleaned!: () => void;
        const starting = new Promise((resolve) => { release = resolve; });
        const entered = new Promise<void>((resolve) => { started = resolve; });
        const cleanup = new Promise<void>((resolve) => { cleaned = resolve; });
        let kills = 0;
        let goneCalls = 0;
        const runner = { start: async () => { started(); return starting; } };
        const controller = new AbortController();
        const input = workerInput(root, controller.signal, 5000);
        const running = createLowAdapter(adapterDeps(input, runner)).run(input as never);
        await entered;
        controller.abort();
        const result = await running;
        expect(result.stopCause).toBe("interrupted");
        expect(result.cessation).toBe("unproven");
        expect(result.cessationCheck).toBe("vm-start-unsettled");
        release({
          exited: Promise.resolve({ code: null }),
          kill: async () => { kills++; if (killFails) throw new Error("kill failed"); },
          gone: async () => { goneCalls++; rmSync(privateSession, { recursive: true, force: true }); cleaned(); return true; },
          output: async () => "",
        });
        await Promise.race([cleanup, Bun.sleep(300)]);
        expect(kills).toBe(1);
        expect(goneCalls).toBe(1);
        expect(existsSync(privateSession)).toBe(false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("unverified worker output is not committed without host verification", async () => {
    const { createLowAdapter } = await import("../../src/work/adapter-low");
    const root = mkdtempSync(join(tmpdir(), "low-unverified-"));
    try {
      const gitCalls: string[][] = [];
      const input = workerInput(root, new AbortController().signal);
      const runner = { start: async () => ({
        exited: Promise.resolve({ code: 1 }), kill: async () => {}, gone: async () => true, output: async () => "",
      }) };
      const result = await createLowAdapter({
        ...adapterDeps(input, runner) as object,
        runner,
        treeGit: (_tree: string, args: string[]) => { gitCalls.push(args); return "a".repeat(40); },
      } as never).run(input as never);
      expect(result.stopCause).toBe("unverified");
      expect(gitCalls).toEqual([["rev-parse", "--verify", `refs/heads/${input.work.branch}^{commit}`]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("cleanup failure stops completion after proven cessation", async () => {
    const { createLowAdapter } = await import("../../src/work/adapter-low");
    const root = mkdtempSync(join(tmpdir(), "low-cleanup-"));
    try {
      const input = workerInput(root, new AbortController().signal);
      const gitCalls: string[][] = [];
      const logs: string[] = [];
      const runner = { start: async () => ({
        exited: Promise.resolve({ code: 0 }), kill: async () => {}, gone: async () => true,
        cleanupError: () => "cleanup failed: permission denied", output: async () => "",
      }) };
      const result = await createLowAdapter({ ...adapterDeps(input, runner) as object, runner,
        treeGit: (_tree: string, args: string[]) => { gitCalls.push(args); return "a".repeat(40); }, log: (message: string) => logs.push(message),
      } as never).run(input as never);
      expect(result.stopCause).toBe("worker_error");
      expect(result.cessation).toBe("proven");
      expect(gitCalls).toEqual([["rev-parse", "--verify", `refs/heads/${input.work.branch}^{commit}`]]);
      expect(logs.join("\n")).toContain("cleanup failed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("session token copied into a file never becomes a host commit", async () => {
    const { createLowAdapter } = await import("../../src/work/adapter-low");
    const root = mkdtempSync(join(tmpdir(), "low-token-tree-"));
    const tree = join(root, "tree");
    mkdirSync(tree);
    const git = (_tree: string, args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: tree, env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    try {
      git(tree, ["init", "-q", "-b", "work/7-wabc1234ef0"]);
      git(tree, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
      const base = git(tree, ["rev-parse", "HEAD"]);
      const input = workerInput(root, new AbortController().signal);
      const runner = { start: async ({ gatewayToken }: { gatewayToken: string }) => {
        writeFileSync(join(tree, "leak.txt"), `token=${gatewayToken}\n`);
        return { exited: Promise.resolve({ code: 0 }), kill: async () => {}, gone: async () => true, output: async () => "" };
      } };
      const result = await createLowAdapter({ ...adapterDeps(input, runner) as object, runner, treeGit: git } as never).run(input as never);
      expect(result.stopCause).not.toBe("done");
      expect(git(tree, ["rev-parse", "HEAD"])).toBe(base);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("worker-created commit is refused before host publish", async () => {
    const { createLowAdapter } = await import("../../src/work/adapter-low");
    const root = mkdtempSync(join(tmpdir(), "low-worker-commit-"));
    const tree = join(root, "tree");
    mkdirSync(tree);
    const git = (_tree: string, args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: tree,
        env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    try {
      git(tree, ["init", "-q", "-b", "work/7-wabc1234ef0"]);
      git(tree, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
      const input = workerInput(root, new AbortController().signal);
      const runner = { start: async ({ gatewayToken }: { gatewayToken: string }) => {
        writeFileSync(join(tree, "leak.txt"), gatewayToken);
        git(tree, ["add", "leak.txt"]);
        git(tree, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "worker"]);
        return { exited: Promise.resolve({ code: 0 }), kill: async () => {}, gone: async () => true, output: async () => "" };
      } };
      const result = await createLowAdapter({ ...adapterDeps(input, runner) as object, runner, treeGit: git } as never).run(input as never);
      expect(result.stopCause).toBe("blocked");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("worker clean filter is refused before it can execute during completion", async () => {
    const { createLowAdapter } = await import("../../src/work/adapter-low");
    const root = mkdtempSync(join(tmpdir(), "low-token-filter-"));
    const tree = join(root, "tree");
    mkdirSync(tree);
    const git = (_tree: string, args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: tree,
        env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    try {
      git(tree, ["init", "-q", "-b", "work/7-wabc1234ef0"]);
      git(tree, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
      const base = git(tree, ["rev-parse", "HEAD"]);
      const input = workerInput(root, new AbortController().signal);
      const runner = { start: async ({ gatewayToken }: { gatewayToken: string }) => {
        git(tree, ["config", "filter.leak.clean", `touch ${join(root, "filter-ran")}; printf %s ${gatewayToken}`]);
        writeFileSync(join(tree, ".gitattributes"), "input.txt filter=leak\n");
        writeFileSync(join(tree, "input.txt"), "ordinary source without the token\n");
        return { exited: Promise.resolve({ code: 0 }), kill: async () => {}, gone: async () => true, output: async () => "" };
      } };
      const result = await createLowAdapter({ ...adapterDeps(input, runner) as object, runner, treeGit: git } as never).run(input as never);
      expect(result.stopCause).toBe("blocked");
      expect(existsSync(join(root, "filter-ran"))).toBe(false);
      expect(git(tree, ["rev-parse", "HEAD"])).toBe(base);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("low-completion-publish-generated", async () => {
    const { createLowAdapter } = await import("../../src/work/adapter-low");
    const { publishCommittedWork } = await import("../../src/work/publish-fallback");
    const root = mkdtempSync(join(tmpdir(), "low-publish-generated-"));
    const tree = join(root, "tree");
    mkdirSync(tree);
    const git = (_tree: string, args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: tree, env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    try {
      git(tree, ["init", "-q", "-b", "work/7-wabc1234ef0"]);
      writeFileSync(join(tree, "tracked.pyc"), "initial");
      git(tree, ["add", "tracked.pyc"]);
      git(tree, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
      const base = git(tree, ["rev-parse", "HEAD"]);
      const input = workerInput(root, new AbortController().signal);
      const runner = { start: async () => {
        writeFileSync(join(tree, "calculator.py"), "answer = 42\n");
        writeFileSync(join(tree, "tracked.pyc"), "changed tracked file");
        mkdirSync(join(tree, "__pycache__"));
        writeFileSync(join(tree, "__pycache__", "calculator.pyc"), "generated");
        return { exited: Promise.resolve({ code: 0 }), kill: async () => {}, gone: async () => true, output: async () => "" };
      } };
      const result = await createLowAdapter({ ...adapterDeps(input, runner) as object, runner, treeGit: git } as never).run(input as never);
      expect(result.stopCause).toBe("done");
      expect(git(tree, ["show", "--format=", "--name-only", "HEAD"])).toBe("calculator.py\ntracked.pyc");
      const writes: string[] = [];
      const deps = {
        git, base, excludeGenerated: true,
        findPullRequest: async () => null,
        issue: async () => ({ title: "test", body: "" }),
        publish: async (_work: unknown, request: { action: string }) => { writes.push(request.action); return JSON.stringify({ status: "ok" }); },
      };
      const request = { work: input.work, kind: "start-work", stopCause: "done" } as never;
      expect(await publishCommittedWork(deps as never, request)).toEqual({ published: true });
      expect(writes).toEqual(["push", "open_pr"]);
      writes.length = 0;
      expect(await publishCommittedWork({ ...deps, excludeGenerated: false } as never, request))
        .toEqual({ published: false, reason: "working tree is not clean" });
      expect(writes).toEqual([]);
      writeFileSync(join(tree, "tracked.pyc"), "uncommitted tracked change");
      writes.length = 0;
      expect(await publishCommittedWork(deps as never, request)).toEqual({ published: false, reason: "working tree is not clean" });
      expect(writes).toEqual([]);
      writeFileSync(join(tree, "tracked.pyc"), "changed tracked file");
      writeFileSync(join(tree, "uncommitted.py"), "uncommitted");
      writes.length = 0;
      expect(await publishCommittedWork(deps as never, request)).toEqual({ published: false, reason: "working tree is not clean" });
      expect(writes).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("low-completion", async () => {
    const { createLowAdapter } = await import("../../src/work/adapter-low");
    const root = mkdtempSync(join(tmpdir(), "low-completion-"));
    const tree = join(root, "tree");
    mkdirSync(tree);
    const git = (args: string[]) => {
      const r = Bun.spawnSync(["git", ...args], {
        cwd: tree, env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      return r.stdout.toString().trim();
    };
    try {
      git(["init", "-q", "-b", "work/7-wabc1234ef0"]);
      writeFileSync(join(tree, "tracked.pyc"), "tracked before worker");
      git(["add", "tracked.pyc"]);
      git(["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
      const initial = git(["rev-parse", "HEAD"]);
      const controller = new AbortController();
      const input = workerInput(root, controller.signal);
      const deps = { ...adapterDeps(input, null) as object, treeGit: (_tree: string, args: string[]) => git(args) };
      const runner = { start: async () => {
        writeFileSync(join(tree, "change.txt"), "one\n");
        mkdirSync(join(tree, "__pycache__"));
        writeFileSync(join(tree, "__pycache__", "generated.pyc"), "generated");
        mkdirSync(join(tree, "node_modules"));
        writeFileSync(join(tree, "node_modules", "generated"), "generated");
        mkdirSync(join(tree, ".venv"));
        writeFileSync(join(tree, ".venv", "generated"), "generated");
        writeFileSync(join(tree, ".DS_Store"), "generated");
        writeFileSync(join(tree, "untracked.pyc"), "generated");
        writeFileSync(join(tree, "tracked.pyc"), "already tracked; retain change");
        return { exited: Promise.resolve({ code: 0 }), kill: async () => {}, gone: async () => true, output: async () => "" };
      } };
      const result = await createLowAdapter({ ...deps, runner } as never).run(input as never);
      expect(result.cessation).toBe("proven");
      expect(git(["rev-parse", "HEAD"])).not.toBe(initial);
      expect(git(["show", "--format=", "--name-only", "HEAD"])).toBe("change.txt\ntracked.pyc");

      const committed = git(["rev-parse", "HEAD"]);
      const lost = new AbortController();
      const lostInput = workerInput(root, lost.signal);
      const lostRunner = { start: async () => {
        writeFileSync(join(tree, "change.txt"), "two\n");
        lost.abort();
        return { exited: Promise.resolve({ code: 0 }), kill: async () => {}, gone: async () => true, output: async () => "" };
      } };
      await createLowAdapter({ ...adapterDeps(lostInput, lostRunner) as object, runner: lostRunner, treeGit: (_tree: string, args: string[]) => git(args) } as never).run(lostInput as never);
      expect(git(["rev-parse", "HEAD"])).toBe(committed);
      expect(git(["status", "--porcelain"])).not.toBe("");

      const failures: string[] = [];
      let sessionToken = "";
      const lastInput = workerInput(root, new AbortController().signal);
      const cleanRunner = { start: async ({ gatewayToken }: { gatewayToken: string }) => {
        sessionToken = gatewayToken;
        return { exited: Promise.resolve({ code: 0 }), kill: async () => {}, gone: async () => true, output: async () => "" };
      } };
      const failedCompletion = await createLowAdapter({
        ...adapterDeps(lastInput, cleanRunner) as object,
        treeGit: () => {
          if (!sessionToken) return "a".repeat(40);
          throw new Error(`tree refused ${sessionToken}`);
        },
        log: (message: string) => failures.push(message),
      } as never).run(lastInput as never);
      expect(failedCompletion.stopCause).toBe("worker_error");
      expect(failures.join("\n")).toContain("tree refused");
      expect(failures.join("\n")).not.toContain(sessionToken);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("low-continuation-gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "low-continuation-"));
    const store = WorkStore.open(":memory:", { rootBase: root });
    const body = "approved issue";
    const digest = issueDigest12(body);
    let executions = 0;
    const executor = (adapterKind: string) => ({
      adapterKind, ready: () => ({ ok: true as const }),
      runSession: async () => {
        executions++;
        return { stopCause: "max_reached" as const, iterations: 1, execMs: 1, cessation: "proven" as const };
      },
    });
    const run = async (id: string, adapterKind: string) => {
      const handler = createWorkHandler({
        store, executor: executor(adapterKind), heartbeatMs: 1000,
        config: loadWorkConfig({ externalAdapter: adapterKind === "low" ? "low" : "off" }),
        github: { issue: async () => ({ title: "issue", body }) } as never,
        collectEvidence: async () => ({ ok: false, reason: "not used" }),
        continuation: () => ({ ok: false, reason: "recovery required" }),
      } as never);
      return handler.run({
        worker: "finn", claim: { id: `claim-${id}` },
        job: { id: `job-${id}`, type: "start-work", target: { repo: "rfcclub/anima", number: adapterKind === "loop" ? 8 : 7 }, workRef: `${id}.${digest}` },
        jobs: {},
      } as never);
    };
    try {
      await run("wabc1234ef0", "low");
      expect(executions).toBe(0);
      expect(store.listSessions("wabc1234ef0")).toHaveLength(0);
      expect(store.getWork("wabc1234ef0")?.blockedReason).toContain("recovery required");
      await run("wabc1234ef1", "loop");
      expect(executions).toBe(1);
      expect(store.listSessions("wabc1234ef1")).toHaveLength(1);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
