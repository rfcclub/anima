import { test, expect, describe, beforeEach } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatbeltTest } from "../helpers/seatbelt";
import { prepareWorkspace } from "../../src/work/workspace";
import { sanitizedEnv } from "../../src/work/sandbox";

let tmp: string, remote: string, writer: string, source: string;
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    cwd, env: { PATH: process.env.PATH ?? "", HOME: tmp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (r.exitCode) throw new Error(`git ${args[0]}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
function advance(value: string): string {
  writeFileSync(join(writer, "base.txt"), value);
  git(writer, "add", "base.txt");
  git(writer, "commit", "-qm", value);
  git(writer, "push", "-q", "origin", "main");
  return git(writer, "rev-parse", "HEAD");
}
const attempt = (name: string, extra: { signal?: AbortSignal } = {}) => Promise.resolve().then(() =>
  prepareWorkspace({ root: join(tmp, name), source, branch: `work/254-${name}`, base: "main", ...extra }));

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "work-refresh-")));
  remote = join(tmp, "remote.git"); writer = join(tmp, "writer"); source = join(tmp, "source");
  git(tmp, "init", "--bare", "-q", "-b", "main", remote);
  git(tmp, "clone", "-q", remote, writer);
  advance("one");
  git(tmp, "clone", "-q", remote, source);
});

describe("work source refresh", () => {
  seatbeltTest("each new work uses the fetched base and preserves the dirty source and existing work", async () => {
    const original = git(source, "rev-parse", "HEAD");
    writeFileSync(join(source, "base.txt"), "private unsaved source change");
    const second = advance("two");
    const first = await attempt("first");
    expect(git(first.tree, "rev-parse", "HEAD")).toBe(second);
    expect(git(first.tree, "rev-parse", "refs/remotes/origin/main")).toBe(second);
    expect(git(source, "rev-parse", "HEAD")).toBe(original);
    expect(readFileSync(join(source, "base.txt"), "utf8")).toBe("private unsaved source change");
    writeFileSync(join(first.tree, "unfinished.txt"), "keep");
    const third = advance("three");
    const again = await attempt("first");
    const other = await attempt("second");
    expect(again.created).toBe(false);
    expect(git(again.tree, "rev-parse", "HEAD")).toBe(second);
    expect(readFileSync(join(again.tree, "unfinished.txt"), "utf8")).toBe("keep");
    expect(git(other.tree, "rev-parse", "HEAD")).toBe(third);
  });

  seatbeltTest("configured base is used even when the source HEAD is a different branch", async () => {
    git(source, "checkout", "-qb", "feature");
    writeFileSync(join(source, "feature.txt"), "feature only");
    git(source, "add", "feature.txt"); git(source, "commit", "-qm", "feature");
    const feature = git(source, "rev-parse", "HEAD");
    const latest = advance("two");
    const ws = await attempt("base-choice");
    expect(git(ws.tree, "rev-parse", "HEAD")).toBe(latest);
    expect(existsSync(join(ws.tree, "feature.txt"))).toBe(false);
    expect(git(source, "rev-parse", "HEAD")).toBe(feature);
    expect(git(source, "branch", "--show-current")).toBe("feature");
  });

  seatbeltTest("a divergent source base is refused without changing it", async () => {
    writeFileSync(join(source, "local.txt"), "local");
    git(source, "add", "local.txt"); git(source, "commit", "-qm", "local");
    const localHead = git(source, "rev-parse", "HEAD");
    advance("two");
    await expect(attempt("diverged")).rejects.toThrow(/fast.forward|diverg/i);
    expect(git(source, "rev-parse", "HEAD")).toBe(localHead);
    expect(readFileSync(join(source, "local.txt"), "utf8")).toBe("local");
    expect(existsSync(join(tmp, "diverged", "tree", ".git"))).toBe(false);
  });

  seatbeltTest("a source base ahead of upstream is refused without discarding its commit", async () => {
    writeFileSync(join(source, "local.txt"), "not on upstream");
    git(source, "add", "local.txt"); git(source, "commit", "-qm", "local-only");
    const localHead = git(source, "rev-parse", "HEAD");
    await expect(attempt("ahead")).rejects.toThrow(/fast.forward|diverg/i);
    expect(git(source, "rev-parse", "HEAD")).toBe(localHead);
    expect(existsSync(join(tmp, "ahead", "tree", ".git"))).toBe(false);
  });

  seatbeltTest("missing upstream and failed fetch refuse to create a usable workspace", async () => {
    git(source, "branch", "--unset-upstream", "main");
    await expect(attempt("no-upstream")).rejects.toThrow(/upstream|tracking/i);
    expect(existsSync(join(tmp, "no-upstream", "tree", ".git"))).toBe(false);
    git(source, "config", "branch.main.remote", "origin");
    git(source, "config", "branch.main.merge", "refs/heads/main");
    const sensitive = join(tmp, "private-url-component-do-not-log", "missing.git");
    git(source, "remote", "set-url", "origin", sensitive);
    const error = await attempt("bad-remote").then(() => "unexpected success", e => String(e));
    expect(error).toMatch(/fetch|upstream/i);
    expect(error).not.toContain("private-url-component-do-not-log");
    expect(existsSync(join(tmp, "bad-remote", "tree", ".git"))).toBe(false);
  });

  seatbeltTest("source-configured ext remote cannot run a host command even when Git enables the helper", async () => {
    const realGit = Bun.which("git")!;
    const bin = join(tmp, "ext-bin"), marker = join(tmp, "ext-helper-ran");
    mkdirSync(bin);
    const helper = join(bin, "helper");
    writeFileSync(helper, `#!/bin/sh\nprintf ran > "${marker}"\nexit 1\n`);
    chmodSync(helper, 0o755);
    // Simulate a Git configuration enabling ext: the host's protocol boundary must override it.
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" fetch "*) exec "${realGit}" -c protocol.ext.allow=always "$@";; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    git(source, "remote", "set-url", "origin", `ext::${helper}`);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    try {
      await expect(attempt("ext-url")).rejects.toThrow(/fetch/i);
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  seatbeltTest("source-configured custom remote helper cannot execute on the host", async () => {
    const bin = join(tmp, "remote-helper-bin"), marker = join(tmp, "custom-helper-ran");
    mkdirSync(bin);
    writeFileSync(join(bin, "git-remote-probe"), `#!/bin/sh\nprintf ran > "${marker}"\nexit 1\n`);
    chmodSync(join(bin, "git-remote-probe"), 0o755);
    git(source, "remote", "set-url", "origin", "probe::payload");
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    try {
      await expect(attempt("custom-helper")).rejects.toThrow(/fetch/i);
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  seatbeltTest("a custom helper in a direct clone URL cannot execute on the host", async () => {
    const bin = join(tmp, "direct-helper-bin"), marker = join(tmp, "direct-helper-ran");
    mkdirSync(bin);
    writeFileSync(join(bin, "git-remote-probe"), `#!/bin/sh\nprintf ran > "${marker}"\nexit 1\n`);
    chmodSync(join(bin, "git-remote-probe"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    try {
      await expect(prepareWorkspace({
        root: join(tmp, "direct-helper"), source: "probe::payload", branch: "work/direct", base: "main",
      })).rejects.toThrow(/clone/i);
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  seatbeltTest("relative remote URLs resolve from the source checkout", async () => {
    git(source, "remote", "set-url", "origin", "../remote.git");
    const latest = advance("two");
    const ws = await attempt("relative");
    expect(git(ws.tree, "rev-parse", "HEAD")).toBe(latest);
  });

  seatbeltTest("a symlinked source resolves relative remotes from the physical checkout", async () => {
    git(source, "remote", "set-url", "origin", "../remote.git");
    const aliasDir = join(tmp, "aliases");
    mkdirSync(aliasDir);
    const alias = join(aliasDir, "source");
    symlinkSync(source, alias);
    const latest = advance("symlink-upstream");
    const ws = await prepareWorkspace({
      root: join(tmp, "symlink"), source: alias, branch: "work/254-symlink", base: "main",
    });
    expect(git(ws.tree, "rev-parse", "HEAD")).toBe(latest);
  });

  seatbeltTest("a remote with several fetch URLs uses Git's first URL, not a stale secondary", async () => {
    const secondary = join(tmp, "secondary.git");
    git(tmp, "clone", "--bare", "-q", remote, secondary);
    git(source, "remote", "set-url", "--add", "origin", secondary);
    const latest = advance("primary-advanced");
    const ws = await attempt("multiple-urls");
    expect(git(ws.tree, "rev-parse", "HEAD")).toBe(latest);
  });

  seatbeltTest("a bare mirror with no branch tracking refreshes from its configured origin", async () => {
    const mirror = join(tmp, "operator-mirror.git");
    git(tmp, "clone", "--mirror", "-q", remote, mirror);
    const oldMirror = git(mirror, "rev-parse", "refs/heads/main");
    const latest = advance("after-mirror");
    const ws = await prepareWorkspace({
      root: join(tmp, "mirror-work"), source: mirror, branch: "work/254-mirror", base: "main",
    });
    expect(git(ws.tree, "rev-parse", "HEAD")).toBe(latest);
    expect(git(mirror, "rev-parse", "refs/heads/main")).toBe(oldMirror);
  });

  seatbeltTest("a bare mirror with incomplete branch tracking is refused rather than guessed", async () => {
    const mirror = join(tmp, "partly-configured.git");
    git(tmp, "clone", "--mirror", "-q", remote, mirror);
    git(mirror, "config", "branch.main.remote", "some-other-remote");
    await expect(prepareWorkspace({
      root: join(tmp, "partly-configured-work"), source: mirror, branch: "work/254-partial", base: "main",
    })).rejects.toThrow(/upstream|tracking/i);
  });

  seatbeltTest("a later fetch from the stale local source cannot regress the fetched base ref", async () => {
    const latest = advance("fresh-base");
    const ws = await attempt("later-fetch");
    expect(git(ws.tree, "rev-parse", "refs/remotes/origin/main")).toBe(latest);
    git(ws.tree, "fetch", "-q", "origin");
    expect(git(ws.tree, "rev-parse", "refs/remotes/origin/main")).toBe(latest);
  });

  seatbeltTest("a slow clone is not stopped by the 60-second fetch timeout", async () => {
    const realGit = Bun.which("git")!;
    const bin = join(tmp, "slow-clone-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" clone "*) sleep 0.2;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const oldPath = process.env.PATH;
    const originalTimeout = globalThis.setTimeout;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    // Accelerate only the existing 60-second timer, not unrelated timers or the clone itself.
    globalThis.setTimeout = ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) =>
      originalTimeout(fn, ms === 60_000 ? 50 : ms, ...args)) as typeof setTimeout;
    try {
      const ws = await attempt("slow-clone");
      expect(git(ws.tree, "rev-parse", "HEAD")).toBe(git(source, "rev-parse", "HEAD"));
    } finally {
      globalThis.setTimeout = originalTimeout;
      process.env.PATH = oldPath;
    }
  });

  seatbeltTest("a remote URL clones the configured branch even if remote HEAD differs", async () => {
    const latest = advance("two");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/not-main");
    const ws = await prepareWorkspace({
      root: join(tmp, "remote-url"), source: `file://${remote}`, branch: "work/254-url", base: "main",
    });
    const head = Bun.spawnSync(["git", "-C", ws.tree, "rev-parse", "--verify", "HEAD"]);
    expect(head.exitCode).toBe(0);
    expect(head.stdout.toString().trim()).toBe(latest);
    expect(git(ws.tree, "rev-parse", "refs/remotes/origin/main")).toBe(latest);
  });

  seatbeltTest("concurrent new works get the fresh base without changing the shared source", async () => {
    const oldHead = git(source, "rev-parse", "HEAD");
    const latest = advance("two");
    const [first, second] = await Promise.all([attempt("parallel-one"), attempt("parallel-two")]);
    expect(git(first.tree, "rev-parse", "HEAD")).toBe(latest);
    expect(git(second.tree, "rev-parse", "HEAD")).toBe(latest);
    expect(git(source, "rev-parse", "HEAD")).toBe(oldHead);
  });

  seatbeltTest("a host SSH agent is available to the upstream fetch", async () => {
    const realGit = Bun.which("git")!;
    const bin = join(tmp, "agent-bin"), marker = join(tmp, "agent-seen"), socket = join(tmp, "agent.sock");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" fetch "*) [ "$SSH_AUTH_SOCK" = "${socket}" ] || exit 93; touch "${marker}";; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const oldPath = process.env.PATH, oldSocket = process.env.SSH_AUTH_SOCK;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    process.env.SSH_AUTH_SOCK = socket;
    try {
      const outcome = await attempt("agent").then(() => "fetched", () => "failed");
      expect(outcome).toBe("fetched");
      expect(existsSync(marker)).toBe(true);
      expect(sanitizedEnv({ SSH_AUTH_SOCK: socket }, { home: tmp, tmp }).SSH_AUTH_SOCK).toBeUndefined();
    } finally {
      process.env.PATH = oldPath;
      if (oldSocket === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = oldSocket;
    }
  });

  seatbeltTest("an explicitly configured host SSH command reaches only host Git, not worker tools", async () => {
    const realGit = Bun.which("git")!;
    const bin = join(tmp, "ssh-command-bin"), marker = join(tmp, "ssh-command-seen");
    const sshCommand = "ssh -o BatchMode=yes";
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" fetch "*) [ "$GIT_SSH_COMMAND" = "${sshCommand}" ] || exit 93; touch "${marker}";; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const oldPath = process.env.PATH, oldCommand = process.env.GIT_SSH_COMMAND;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    process.env.GIT_SSH_COMMAND = sshCommand;
    try {
      await attempt("ssh-command");
      expect(existsSync(marker)).toBe(true);
      expect(sanitizedEnv({ GIT_SSH_COMMAND: sshCommand }, { home: tmp, tmp }).GIT_SSH_COMMAND).toBeUndefined();
    } finally {
      process.env.PATH = oldPath;
      if (oldCommand === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = oldCommand;
    }
  });

  seatbeltTest("existing work is reused even after the upstream becomes unavailable", async () => {
    const ws = await attempt("reuse");
    writeFileSync(join(ws.tree, "unfinished.txt"), "keep this work");
    git(source, "remote", "set-url", "origin", join(tmp, "unreachable.git"));
    const reused = await attempt("reuse");
    expect(reused.created).toBe(false);
    expect(readFileSync(join(reused.tree, "unfinished.txt"), "utf8")).toBe("keep this work");
  });

  seatbeltTest("a slow fetch leaves the event loop responsive and is cancelled on abort", async () => {
    const realGit = Bun.which("git")!;
    const marker = join(tmp, "fetch-started");
    const bin = join(tmp, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" fetch "*) echo $$ > "${marker}"; exec /bin/sleep 5;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    const abort = new AbortController();
    let heartbeats = 0;
    const heartbeat = setInterval(() => { heartbeats++; }, 20);
    const result = attempt("cancel", { signal: abort.signal }).then(() => "completed", () => "rejected");
    try {
      const deadline = Date.now() + 2_500;
      while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(marker)).toBe(true);
      await Bun.sleep(150);
      abort.abort();
      expect(await result).toBe("rejected");
      expect(heartbeats).toBeGreaterThan(2);
      const pid = Number(readFileSync(marker, "utf8").trim());
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
      expect(existsSync(join(tmp, "cancel", "tree", ".git"))).toBe(false);
    } finally {
      abort.abort(); clearInterval(heartbeat); process.env.PATH = oldPath;
    }
  });

  seatbeltTest("a partial final clone with unproven cessation is never reused or cloned again", async () => {
    const realGit = Bun.which("git")!;
    const bin = join(tmp, "partial-clone-bin"), marker = join(tmp, "partial-clone-started");
    const root = join(tmp, "partial-clone");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh
case " $* " in
  *" --separate-git-dir "*)
    "${realGit}" init -q --separate-git-dir "${join(root, "git")}" "${join(root, "tree")}" || exit 1
    touch "${marker}"
    exec /bin/sleep 30
    ;;
esac
exec "${realGit}" "$@"
`);
    chmodSync(join(bin, "git"), 0o755);
    const oldPath = process.env.PATH, abort = new AbortController();
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    const first = attempt("partial-clone", { signal: abort.signal }).then(() => null, e => e);
    try {
      const deadline = Date.now() + 2_500;
      while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(marker)).toBe(true);
      expect(existsSync(join(root, "tree", ".git"))).toBe(true);
      abort.abort();
      expect((await first)?.cessation).toBe("unproven");
      const mirrorsBefore = readdirSync(root).filter(name => name.startsWith(".anima-work-source-"));
      expect(mirrorsBefore).toHaveLength(1);
      const retry = await attempt("partial-clone").then(() => null, e => e);
      expect(String(retry)).toMatch(/preparation.*(unproven|recovery)/i);
      expect(existsSync(join(root, "tree", ".git"))).toBe(true);
      expect(readdirSync(root).filter(name => name.startsWith(".anima-work-source-"))).toEqual(mirrorsBefore);
    } finally {
      abort.abort();
      process.env.PATH = oldPath;
    }
  }, 15_000);

  seatbeltTest("a legacy partial clone with no HEAD is refused before checkout", async () => {
    const root = join(tmp, "legacy-partial");
    mkdirSync(root);
    git(root, "init", "-q", "--separate-git-dir", join(root, "git"), join(root, "tree"));
    const before = readFileSync(join(root, "git", "HEAD"), "utf8");
    const error = await attempt("legacy-partial").then(() => null, e => e);
    expect(String(error)).toMatch(/incomplete.*recovery/i);
    expect(readFileSync(join(root, "git", "HEAD"), "utf8")).toBe(before);
    expect(existsSync(join(root, ".anima-work-preparing"))).toBe(false);
    const retry = await attempt("legacy-partial").then(() => null, e => e);
    expect(String(retry)).toMatch(/incomplete workspace has no committed HEAD/i);
  });

  seatbeltTest("a retained source mirror without a marker blocks another preparation", async () => {
    const root = join(tmp, "retained-mirror"), oldMirror = join(root, ".anima-work-source-old");
    mkdirSync(oldMirror, { recursive: true });
    writeFileSync(join(oldMirror, "keep"), "possibly still in use");
    const error = await attempt("retained-mirror").then(() => null, e => e);
    expect(String(error)).toMatch(/preparation.*recovery/i);
    expect(readFileSync(join(oldMirror, "keep"), "utf8")).toBe("possibly still in use");
    expect(readdirSync(root).filter(name => name.startsWith(".anima-work-source-"))).toEqual([".anima-work-source-old"]);
    expect(existsSync(join(root, ".anima-work-preparing"))).toBe(true);
  });

  seatbeltTest("an abort with an unavailable process sweep preserves the temporary source and reports unproven cessation", async () => {
    const realGit = Bun.which("git")!;
    const marker = join(tmp, "unproven-fetch-started"), bin = join(tmp, "unproven-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" fetch "*) touch "${marker}"; exec /bin/sleep 30;; esac\nexec "${realGit}" "$@"\n`);
    writeFileSync(join(bin, "lsof"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "git"), 0o755); chmodSync(join(bin, "lsof"), 0o755);
    const root = join(tmp, "unproven");
    // Bun resolves commands in spawnSync from the environment at its own startup.
    // Start a child Bun with the failing lsof on PATH so this exercises the real sweep.
    const script = `
      import { prepareWorkspace } from "./src/work/workspace";
      import { existsSync } from "node:fs";
      const abort = new AbortController();
      const result = prepareWorkspace({ root: ${JSON.stringify(root)}, source: ${JSON.stringify(source)},
        branch: "work/254-unproven", base: "main", signal: abort.signal }).then(() => null, e => e);
      const deadline = Date.now() + 2500;
      while (!existsSync(${JSON.stringify(marker)}) && Date.now() < deadline) await Bun.sleep(20);
      if (!existsSync(${JSON.stringify(marker)})) throw new Error("fetch did not start");
      abort.abort();
      const error = await result;
      console.log(JSON.stringify({ cessation: error?.cessation }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(), env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdout: "pipe", stderr: "pipe",
    });
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, errors }).toEqual({ code: 0, errors: "" });
    expect(JSON.parse(output).cessation).toBe("unproven");
    expect(readdirSync(root).some(name => name.startsWith(".anima-work-source-"))).toBe(true);
    expect(existsSync(join(root, "tree", ".git"))).toBe(false);
  });

  seatbeltTest("a detached fetch helper outside the work root is not called proven stopped", async () => {
    const realGit = Bun.which("git")!, python = Bun.which("python3")!;
    const bin = join(tmp, "detached-bin"), marker = join(tmp, "detached.pid");
    mkdirSync(bin);
    const helper = join(bin, "helper.py");
    writeFileSync(helper, `import os, time\nos.setsid()\nos.chdir("/tmp")\nopen(${JSON.stringify(marker)}, "w").write(str(os.getpid()))\ntime.sleep(30)\n`);
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" fetch "*) "${python}" "${helper}" &\nwhile [ ! -f "${marker}" ]; do sleep 0.01; done\nexec /bin/sleep 30;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const oldPath = process.env.PATH, abort = new AbortController();
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    const result = attempt("detached", { signal: abort.signal }).then(() => null, e => e);
    try {
      const deadline = Date.now() + 2500;
      while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(marker)).toBe(true);
      abort.abort();
      const error = await result;
      expect(error?.cessation).toBe("unproven");
    } finally {
      abort.abort(); process.env.PATH = oldPath;
      if (existsSync(marker)) {
        try { process.kill(Number(readFileSync(marker, "utf8").trim()), "SIGKILL"); } catch { /* already exited */ }
      }
    }
  });
});
