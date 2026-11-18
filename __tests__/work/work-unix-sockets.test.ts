/** Real Seatbelt regression tests for work-local Unix sockets. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sandbox from "../../src/work/sandbox";
import { createWorkTools } from "../../src/work/tools";

const sbx = existsSync(sandbox.SANDBOX_BINARY) ? describe : describe.skip;
let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "wus-")));
  root = join(base, "root"); outside = join(base, "outside");
  for (const d of ["tree", "tmp", "home"]) mkdirSync(join(root, d), { recursive: true });
  mkdirSync(outside);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const localProfile = () => ({ writableRoots: [root], unixSocketRoot: join(root, "tmp") });

sbx("work-local Unix sockets", () => {
  test("a work tool binds and connects inside its temporary directory", async () => {
    const tools = createWorkTools({ root, tree: join(root, "tree"), tmp: join(root, "tmp"), home: join(root, "home"),
      denyReadRoots: [], perCallMs: 5_000, parentEnv: { PATH: process.env.PATH } });
    const script = `const n=require('node:net'),p=process.env.TMPDIR+'/local.sock';const s=n.createServer(c=>c.end('LOCAL_OK'));s.on('error',e=>{console.log('SERVER_ERROR '+e.code);process.exit(2)});s.listen(p,()=>{const c=n.connect(p);c.on('data',d=>{console.log(String(d));s.close()});c.on('error',e=>{console.log('CLIENT_ERROR '+e.code);process.exit(3)})});setTimeout(()=>process.exit(4),3000).unref()`;
    const output = await tools.execute({ id: "t1", name: "bash", arguments: JSON.stringify({ command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` }) });
    expect(output).toContain("LOCAL_OK");
    await tools.stopAll();
  });

  test("a removed work temporary directory can be recreated before sockets are re-enabled", async () => {
    const tools = createWorkTools({ root, tree: join(root, "tree"), tmp: join(root, "tmp"), home: join(root, "home"),
      denyReadRoots: [], perCallMs: 5_000, parentEnv: { PATH: process.env.PATH } });
    const run = (command: string) => tools.execute({ id: "t", name: "bash", arguments: JSON.stringify({ command }) });
    const script = `const n=require('node:net'),p=process.env.TMPDIR+'/repair.sock';const s=n.createServer(c=>c.end('LOCAL_OK'));s.on('error',e=>{console.log('SERVER_ERROR '+e.code);process.exit(2)});s.listen(p,()=>{const c=n.connect(p);c.on('data',d=>{console.log(String(d));s.close()});c.on('error',e=>{console.log('CLIENT_ERROR '+e.code);process.exit(3)})});setTimeout(()=>process.exit(4),3000).unref()`;
    const socketCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    try {
      expect(await run('rmdir "$TMPDIR"; printf REMOVED')).toContain("REMOVED");
      const repair = await run(`mkdir -p "$TMPDIR"; printf RECREATED; ${socketCommand}`);
      expect(repair).toContain("RECREATED");
      expect(repair).toContain("SERVER_ERROR");
      expect(repair).not.toContain("LOCAL_OK");
      expect(await run(socketCommand)).toContain("LOCAL_OK");
    } finally { await tools.stopAll(); }
  });

  test("a work temporary path replaced by a file can be repaired", async () => {
    const tools = createWorkTools({ root, tree: join(root, "tree"), tmp: join(root, "tmp"), home: join(root, "home"),
      denyReadRoots: [], perCallMs: 5_000, parentEnv: { PATH: process.env.PATH } });
    const run = (command: string) => tools.execute({ id: "t", name: "bash", arguments: JSON.stringify({ command }) });
    try {
      expect(await run('rmdir "$TMPDIR"; printf blocker > "$TMPDIR"; printf REPLACED')).toContain("REPLACED");
      expect(await run('rm "$TMPDIR"; mkdir "$TMPDIR"; printf REPAIRED')).toContain("REPAIRED");
    } finally { await tools.stopAll(); }
  });

  test("a dangling temporary-directory symlink is refused rather than treated as missing", async () => {
    const tools = createWorkTools({ root, tree: join(root, "tree"), tmp: join(root, "tmp"), home: join(root, "home"),
      denyReadRoots: [], perCallMs: 5_000, parentEnv: { PATH: process.env.PATH } });
    rmSync(join(root, "tmp"), { recursive: true });
    symlinkSync(join(outside, "missing"), join(root, "tmp"));
    try {
      const result = await tools.execute({ id: "t", name: "bash", arguments: JSON.stringify({ command: "printf SHOULD_NOT_RUN" }) });
      expect(result).toContain("must not be a symlink");
      expect(result).not.toContain("SHOULD_NOT_RUN");
    } finally { await tools.stopAll(); }
  });

  test("outside sockets and their symlink and hardlink aliases, and TCP are refused", async () => {
    const innerPath = join(root, "tmp", "ok.sock"), externalPath = join(outside, "external.sock");
    const inside = Bun.serve({ unix: innerPath, fetch: () => new Response("INNER_OK") });
    const external = Bun.serve({ unix: externalPath, fetch: () => new Response("EXTERNAL_REACHED") });
    const tcp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("TCP_REACHED") });
    const symlink = join(root, "tmp", "symlink.sock"), hardlink = join(root, "tmp", "hardlink.sock");
    symlinkSync(externalPath, symlink); linkSync(externalPath, hardlink);
    const curl = async (target: string, restricted: boolean, isTcp = false) => {
      const args = isTcp ? [target] : ["--unix-socket", target, "http://localhost/"];
      const argv = restricted ? sandbox.sandboxCommand(localProfile(), ["/usr/bin/curl", "-sS", "--max-time", "2", ...args]) : ["/usr/bin/curl", "-sS", "--max-time", "2", ...args];
      const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
      const [code, text] = await Promise.all([p.exited, new Response(p.stdout).text()]);
      return { code, text };
    };
    try {
      expect((await curl(innerPath, true)).text).toBe("INNER_OK");
      for (const path of [externalPath, symlink, hardlink]) {
        expect((await curl(path, false)).text).toBe("EXTERNAL_REACHED");
        expect((await curl(path, true)).code).not.toBe(0);
      }
      const url = `http://127.0.0.1:${tcp.port}/`;
      expect((await curl(url, false, true)).text).toBe("TCP_REACHED");
      expect((await curl(url, true, true)).code).not.toBe(0);
    } finally { inside.stop(true); external.stop(true); tcp.stop(true); }
  });

  test("replacing work/tmp with a symlink cannot expand the grant to another work directory", async () => {
    const tools = createWorkTools({ root, tree: join(root, "tree"), tmp: join(root, "tmp"), home: join(root, "home"),
      denyReadRoots: [], perCallMs: 5_000, parentEnv: { PATH: process.env.PATH } });
    const server = Bun.serve({ unix: join(root, "tree", "other.sock"), fetch: () => new Response("ESCAPED_SCOPE") });
    try {
      rmSync(join(root, "tmp"), { recursive: true });
      symlinkSync(join(root, "tree"), join(root, "tmp"));
      const output = await tools.execute({ id: "t", name: "bash", arguments: JSON.stringify({ command: '/usr/bin/curl -sS --max-time 2 --unix-socket "$TMPDIR/other.sock" http://localhost/' }) });
      expect(output).toContain("could not run");
      expect(output).not.toContain("ESCAPED_SCOPE");
    } finally { server.stop(true); await tools.stopAll(); }
  });

  test("swapping the temporary directory after profile generation cannot expand the grant", async () => {
    const server = Bun.serve({ unix: join(root, "tree", "later.sock"), fetch: () => new Response("LATE_ESCAPE") });
    const profile = sandbox.buildProfile(localProfile());
    try {
      rmSync(join(root, "tmp"), { recursive: true });
      symlinkSync(join(root, "tree"), join(root, "tmp"));
      const args = ["/usr/bin/curl", "-sS", "--max-time", "2", "--unix-socket", join(root, "tmp", "later.sock"), "http://localhost/"];
      const direct = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
      expect(await new Response(direct.stdout).text()).toBe("LATE_ESCAPE");
      const confined = Bun.spawn([sandbox.SANDBOX_BINARY, "-p", profile, ...args], { stdout: "pipe", stderr: "ignore" });
      expect(await confined.exited).not.toBe(0);
      expect(await new Response(confined.stdout).text()).not.toContain("LATE_ESCAPE");
    } finally { server.stop(true); }
  });

  test("default network denial remains in force without a Unix grant", async () => {
    const socket = join(root, "tmp", "default.sock");
    const server = Bun.serve({ unix: socket, fetch: () => new Response("REACHED") });
    try {
      const p = Bun.spawn(sandbox.sandboxCommand({ writableRoots: [root] }, ["/usr/bin/curl", "-sS", "--max-time", "2", "--unix-socket", socket, "http://localhost/"]), { stdout: "ignore", stderr: "ignore" });
      expect(await p.exited).not.toBe(0);
    } finally { server.stop(true); }
  });

  test("runtime socket probe passes real Seatbelt and rejects a non-enforcing binary", async () => {
    const probe = (sandbox as any).probeWorkUnixSockets;
    expect(typeof probe).toBe("function");
    if (typeof probe !== "function") return;
    expect(await probe()).toEqual({ ok: true });
    const fake = join(base, "fake-sandbox");
    writeFileSync(fake, '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 });
    expect(await probe({ binary: fake })).toEqual({ ok: false, reason: expect.stringContaining("isolation unavailable") });
    expect(await probe({ binary: join(base, "missing") })).toEqual({ ok: false, reason: expect.stringContaining("isolation unavailable") });
  }, 20_000);

  test("runtime socket probe fails closed when its temporary directory cannot be created", async () => {
    const probe = (sandbox as any).probeWorkUnixSockets;
    expect(typeof probe).toBe("function");
    if (typeof probe !== "function") return;
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = join(base, "missing", "parent");
    try {
      expect(await probe()).toEqual({ ok: false, reason: expect.stringContaining("isolation unavailable") });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });

  test("runtime socket probing does not block the host event loop", async () => {
    const probe = (sandbox as any).probeWorkUnixSockets;
    expect(typeof probe).toBe("function");
    if (typeof probe !== "function") return;
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    try {
      expect(await probe()).toEqual({ ok: true });
      expect(timerFired).toBe(true);
    } finally { clearTimeout(timer); }
  }, 20_000);

  test("a hung socket probe times out and stops its subprocess group", async () => {
    const probe = (sandbox as any).probeWorkUnixSockets;
    expect(typeof probe).toBe("function");
    if (typeof probe !== "function") return;
    const fake = join(base, "hanging-sandbox"), pidFile = join(base, "pid");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\nexec /bin/sleep 30\n`, { mode: 0o755 });
    let pid = 0;
    try {
      const started = performance.now();
      const result = await probe({ binary: fake, timeoutMs: 2_000 });
      expect(result).toEqual({ ok: false, reason: expect.stringContaining("isolation unavailable") });
      expect(performance.now() - started).toBeLessThan(5_000);
      pid = Number(readFileSync(pidFile, "utf8"));
      let alive = true;
      for (let i = 0; i < 25 && alive; i++) {
        try { process.kill(pid, 0); await Bun.sleep(20); } catch { alive = false; }
      }
      expect(alive).toBe(false);
    } finally {
      if (!pid && existsSync(pidFile)) pid = Number(readFileSync(pidFile, "utf8"));
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  }, 20_000);

  test("the scoped profile still denies outside writes and denied reads", async () => {
    const secret = join(outside, "secret");
    writeFileSync(secret, "PRIVATE_MARKER");
    const profile = { ...localProfile(), denyReadRoots: [outside] };
    const p = Bun.spawn(sandbox.sandboxCommand(profile, ["sh", "-c", `cat '${secret}'; echo bad > '${outside}/written'`]), {
      stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin" },
    });
    const [code, text] = await Promise.all([p.exited, new Response(p.stdout).text()]);
    expect(code).not.toBe(0);
    expect(text).not.toContain("PRIVATE_MARKER");
    expect(existsSync(join(outside, "written"))).toBe(false);
  });
});

describe("Unix socket grant validation", () => {
  test("outside and symlink-escaped roots are rejected", () => {
    const escaped = join(root, "escape"); symlinkSync(outside, escaped);
    for (const path of [outside, escaped]) {
      const opts = { writableRoots: [root], unixSocketRoot: path };
      expect(() => sandbox.buildProfile(opts)).toThrow(RangeError);
    }
    const prefixSibling = `${root}-other`;
    mkdirSync(prefixSibling);
    expect(() => sandbox.buildProfile({ writableRoots: [root], unixSocketRoot: prefixSibling })).toThrow(RangeError);
    const file = join(root, "tmp", "not-a-directory");
    writeFileSync(file, "file");
    expect(() => sandbox.buildProfile({ writableRoots: [root], unixSocketRoot: file })).toThrow(RangeError);
    expect(() => sandbox.buildProfile({ ...localProfile(), allowNetwork: true })).toThrow(RangeError);
  });
});
