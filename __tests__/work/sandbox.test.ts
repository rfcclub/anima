/**
 * castle-work-loop, WL-10: the write boundary for a work session's tools.
 * Runs real `sandbox-exec` children; the group is skipped, with the reason printed, where the binary is absent.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProfile, probeSandbox, sandboxCommand, sanitizedEnv, SANDBOX_BINARY, WORK_COMMIT_IDENTITY } from "../../src/work/sandbox";

const available = existsSync(SANDBOX_BINARY);
if (!available) console.warn(`sandbox tests skipped: ${SANDBOX_BINARY} is not present on this platform`);
const sbx = available ? describe : describe.skip;

let base: string;
let root: string;
let outside: string;

function run(argv: string[], opts: { cwd?: string; denyRead?: string[] } = {}) {
  const profile = { writableRoots: [root], denyReadRoots: opts.denyRead ?? [] };
  const r = Bun.spawnSync(sandboxCommand(profile, argv), {
    cwd: opts.cwd ?? join(root, "tree"),
    env: sanitizedEnv({ PATH: process.env.PATH ?? "", GH_TOKEN: "ghp_x" }, { home: join(root, "home"), tmp: join(root, "tmp") }),
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "work-sbx-")));
  root = join(base, "workroot");
  outside = join(base, "outside");
  for (const d of ["tree", "tmp", "home", "git"]) mkdirSync(join(root, d), { recursive: true });
  mkdirSync(outside);
});

sbx("write boundary", () => {
  test("a write inside the work root works", () => {
    const r = run(["sh", "-c", "echo hi > inside.txt"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(root, "tree", "inside.txt"), "utf-8")).toBe("hi\n");
  });

  test("a relative path that climbs out of the root fails and leaves the target absent", () => {
    const r = run(["sh", "-c", `echo x > ../../outside/climb.txt`]);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(outside, "climb.txt"))).toBe(false);
  });

  test("an absolute path outside the root fails", () => {
    const r = run(["sh", "-c", `echo x > ${outside}/abs.txt`]);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(outside, "abs.txt"))).toBe(false);
  });

  test("a write through a symlink that points outside fails", () => {
    symlinkSync(outside, join(root, "tree", "link"));
    const r = run(["sh", "-c", "echo x > link/viaLink.txt"]);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(outside, "viaLink.txt"))).toBe(false);
  });

  test("a child of a child inherits the boundary", () => {
    const r = run(["sh", "-c", `sh -c 'sh -c "echo x > ${outside}/deep.txt"'`]);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(outside, "deep.txt"))).toBe(false);
  });

  test("an existing file outside the root cannot be overwritten, appended to, removed or renamed", () => {
    const target = join(outside, "keep.txt");
    writeFileSync(target, "original\n");
    for (const cmd of [`echo x > ${target}`, `echo x >> ${target}`, `unlink ${target}`, `mv ${target} ${target}.moved`]) {
      expect(run(["sh", "-c", cmd]).code).not.toBe(0);
    }
    expect(readFileSync(target, "utf-8")).toBe("original\n");
  });

  test("build-style steps work inside the root: git init and commit, and a bun script", () => {
    const g = run(["sh", "-c", "git init -q . && echo a > a.txt && git add a.txt && git -c user.name=t -c user.email=t@t commit -q -m one && git log --oneline"]);
    expect(g.code).toBe(0);
    expect(g.out).toContain("one");
    const b = run([process.execPath, "-e", "require('node:fs').writeFileSync('b.txt','from bun')"]);
    expect(b.code).toBe(0);
    expect(readFileSync(join(root, "tree", "b.txt"), "utf-8")).toBe("from bun");
  });

  test("there is no network from inside: a TCP connect to a local listener and a Unix socket connect both fail", async () => {
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(sock) { sock.end("TCP_REACHED"); }, data() {} } });
    const unixPath = join(base, "u.sock");
    const unix = Bun.listen({ unix: unixPath, socket: { open(sock) { sock.end("UNIX_REACHED"); }, data() {} } });
    try {
      // async spawn: the listeners live in this process, so a blocking spawn would starve them
      const ask = async (script: string) => {
        const child = Bun.spawn(sandboxCommand({ writableRoots: [root] }, [process.execPath, "-e", script]), { cwd: join(root, "tree"), stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "" } });
        const text = await new Response(child.stdout).text();
        await child.exited;
        return text;
      };
      const probe = (target: string) => `try{const n=require('node:net');const s=n.connect(${target});s.on('data',d=>{console.log(String(d));process.exit(0)});s.on('error',e=>{console.log('BLOCKED '+e.code);process.exit(0)});setTimeout(()=>{console.log('TIMEOUT');process.exit(0)},2000)}catch(e){console.log('BLOCKED '+e.code)}`;
      // Bun's node:net string overload reports ECONNREFUSED for this working Unix listener.
      const unixProbe = `try{await Bun.connect({unix:${JSON.stringify(unixPath)},socket:{data(s,d){console.log(String(d));process.exit(0)},error(s,e){console.log('BLOCKED '+e.code);process.exit(0)}}});setTimeout(()=>{console.log('TIMEOUT');process.exit(0)},2000)}catch(e){console.log('BLOCKED '+e.code)}`;
      const viaTcp = await ask(probe(`{host:'127.0.0.1',port:${tcp.port}}`));
      const viaUnix = await ask(unixProbe);
      expect(viaTcp).not.toContain("TCP_REACHED");
      expect(viaUnix).toContain("BLOCKED");
      // the same probes outside the boundary do reach the listeners, so the test is not vacuous
      const direct = Bun.spawn([process.execPath, "-e", probe(`{host:'127.0.0.1',port:${tcp.port}}`)], { stdout: "pipe", stderr: "ignore" });
      expect(await new Response(direct.stdout).text()).toContain("TCP_REACHED");
      const directUnix = Bun.spawn([process.execPath, "-e", unixProbe], { stdout: "pipe", stderr: "ignore" });
      expect(await new Response(directUnix.stdout).text()).toContain("UNIX_REACHED");
    } finally {
      tcp.stop(true);
      unix.stop(true);
    }
  });

  test("network can be allowed explicitly, and then it is", async () => {
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(sock) { sock.end("TCP_REACHED"); }, data() {} } });
    try {
      const probe = `const s=require('node:net').connect({host:'127.0.0.1',port:${tcp.port}});s.on('data',d=>{console.log(String(d));process.exit(0)});s.on('error',e=>{console.log('BLOCKED '+e.code);process.exit(0)});setTimeout(()=>{console.log('TIMEOUT');process.exit(0)},2000)`;
      const child = Bun.spawn(sandboxCommand({ writableRoots: [root], allowNetwork: true }, [process.execPath, "-e", probe]), { cwd: join(root, "tree"), stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "" } });
      expect(await new Response(child.stdout).text()).toContain("TCP_REACHED");
      await child.exited;
    } finally {
      tcp.stop(true);
    }
  });

  test("a denied read root cannot be read, and a file outside it still can", () => {
    const secrets = join(base, "secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "key"), "SECRET\n");
    writeFileSync(join(outside, "plain.txt"), "plain\n");
    const denied = run(["sh", "-c", `cat ${secrets}/key`], { denyRead: [secrets] });
    expect(denied.code).not.toBe(0);
    expect(denied.out).not.toContain("SECRET");
    const allowed = run(["sh", "-c", `cat ${outside}/plain.txt`], { denyRead: [secrets] });
    expect(allowed.out).toBe("plain\n");
  });
});

describe("environment", () => {
  test("only an allow-list reaches the child; tokens and ANIMA secrets do not", () => {
    const env = sanitizedEnv(
      { PATH: "/usr/bin", LANG: "C", GH_TOKEN: "a", GITHUB_TOKEN: "b", ANIMA_MESH_TOKEN: "c", ANTHROPIC_API_KEY: "d", HOME: "/real/home", TMPDIR: "/real/tmp", SSH_AUTH_SOCK: "/x" },
      { home: "/w/home", tmp: "/w/tmp" },
    );
    expect(env.HOME).toBe("/w/home");
    expect(env.TMPDIR).toBe("/w/tmp");
    expect(env.PATH).toBe("/usr/bin");
    for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "ANIMA_MESH_TOKEN", "ANTHROPIC_API_KEY", "SSH_AUTH_SOCK"]) expect(k in env).toBe(false);
  });
});

describe("commit identity", () => {
  const sessionEnv = (parent: Record<string, string | undefined> = { PATH: process.env.PATH ?? "" }, home = "/w/home") =>
    sanitizedEnv(parent, { home, tmp: "/w/tmp" });

  test("a session's git identity is a neutral noreply one, never derived from the host account", () => {
    const env = sessionEnv({ PATH: "/usr/bin" });
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("user.name");
    expect(env.GIT_CONFIG_VALUE_0).toBe(WORK_COMMIT_IDENTITY.name);
    expect(env.GIT_CONFIG_KEY_1).toBe("user.email");
    expect(env.GIT_CONFIG_VALUE_1).toBe(WORK_COMMIT_IDENTITY.email);
    expect(WORK_COMMIT_IDENTITY.email).toMatch(/@users\.noreply\.github\.com$/);
  });

  test("it is a default, not a lock: the author and committer variables are not set, so an explicit identity can still win", () => {
    const env = sessionEnv({ PATH: "/usr/bin" });
    for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) expect(k in env).toBe(false);
  });

  test("the parent's git identity and config variables never reach the session", () => {
    const env = sessionEnv({
      PATH: "/usr/bin", GIT_AUTHOR_EMAIL: "real@example.com", GIT_COMMITTER_NAME: "Real Name",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.email", GIT_CONFIG_VALUE_0: "real@example.com", GIT_CONFIG_GLOBAL: "/home/user/.gitconfig",
    });
    expect(env.GIT_CONFIG_VALUE_0).toBe(WORK_COMMIT_IDENTITY.name);
    expect(env.GIT_CONFIG_VALUE_1).toBe(WORK_COMMIT_IDENTITY.email);
    for (const k of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_CONFIG_GLOBAL"]) expect(k in env).toBe(false);
  });

  describe("real git under the session environment", () => {
    let repo: string;
    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), "work-identity-"));
    });
    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    const gitIn = (args: string[]) => {
      const env = { ...sanitizedEnv({ PATH: process.env.PATH ?? "" }, { home: join(repo, "home"), tmp: repo }), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
      return spawnSync("git", ["-C", repo, ...args], { env, encoding: "utf8" });
    };
    const commit = (name: string, extra: string[] = []) => {
      writeFileSync(join(repo, name), `${name}\n`);
      gitIn(["add", name]);
      return gitIn([...extra, "commit", "-q", "-m", name]);
    };
    const last = () => gitIn(["log", "-1", "--format=%an <%ae> | %cn <%ce>"]).stdout.trim();
    const neutral = `${WORK_COMMIT_IDENTITY.name} <${WORK_COMMIT_IDENTITY.email}>`;

    test("a default commit carries the neutral identity", () => {
      gitIn(["init", "-q"]);
      expect(commit("a.txt").status).toBe(0);
      expect(last()).toBe(`${neutral} | ${neutral}`);
    });

    test("an explicit -c identity still wins, so a fixture or the host publisher can choose its own author", () => {
      gitIn(["init", "-q"]);
      expect(commit("b.txt", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"]).status).toBe(0);
      expect(last()).toBe("Fixture <fixture@example.invalid> | Fixture <fixture@example.invalid>");
    });

    test("a configured author.name/author.email still wins for the author, as git resolves them before user.*", () => {
      gitIn(["init", "-q"]);
      gitIn(["config", "author.name", "Planted"]);
      gitIn(["config", "author.email", "planted@example.invalid"]);
      expect(commit("c.txt").status).toBe(0);
      expect(last()).toBe(`Planted <planted@example.invalid> | ${neutral}`);
    });
  });
});

describe("profile and probe", () => {
  test("a root with a quote, backslash or newline is refused instead of being written into the profile", () => {
    for (const bad of ['/tmp/a"b', "/tmp/a\\b", "/tmp/a\nb"]) {
      expect(() => buildProfile({ writableRoots: [bad] })).toThrow(RangeError);
    }
    expect(() => buildProfile({ writableRoots: [] })).toThrow(RangeError);
    expect(() => buildProfile({ writableRoots: ["relative/path"] })).toThrow(RangeError);
  });

  test("the profile denies writes by default and names each writable root once", () => {
    const text = buildProfile({ writableRoots: [root] });
    expect(text).toContain("(deny file-write*)");
    expect(text.split(realpathSync(root)).length - 1).toBe(1);
  });

  (available ? test : test.skip)("the probe passes on this host", () => {
    expect(probeSandbox()).toEqual({ ok: true });
  });

  test("the probe reports unavailable, with a reason, when the binary is missing", () => {
    const r = probeSandbox({ binary: join(base, "no-such-sandbox-exec") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("isolation");
  });

  (available ? test : test.skip)("the probe reports unavailable when the boundary does not hold (a command that ignores the profile)", () => {
    // a stand-in that runs the command without any profile: the probe must notice the outside write succeeded
    const fake = join(base, "fake-sandbox-exec");
    writeFileSync(fake, '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 });
    const r = probeSandbox({ binary: fake });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("isolation");
  });
});
