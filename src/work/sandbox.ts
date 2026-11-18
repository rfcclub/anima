/**
 * Write boundary for a work session's tools (anima #135, WL-10).
 *
 * macOS seatbelt through `sandbox-exec`: every file write is denied except under the work root, and
 * the profile is inherited by every child of the sandboxed command, so a build or test step run by a
 * shell tool cannot write elsewhere. Apple marks `sandbox-exec` deprecated, so nothing here assumes
 * it works: `probeSandbox` runs a real check (write inside, write outside, write through a symlink)
 * and the runner treats a failed probe as "isolation unavailable" and blocks the work. There is no
 * fallback to running without the boundary.
 *
 * Network is denied by default. Work tools may opt into Unix sockets confined to their temporary directory;
 * TCP, UDP and outside Unix sockets remain denied, and the child carries no credentials (see `sanitizedEnv`).
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const SANDBOX_BINARY = "/usr/bin/sandbox-exec";

export interface SandboxProfile {
  /** Absolute, existing directories the command may write under. */
  writableRoots: string[];
  /** Absolute directories the command may not read (credentials, agent substrate secrets). */
  denyReadRoots?: string[];
  /** Network (TCP, UDP, Unix sockets) is denied unless this is true. A session's tools never need it. */
  allowNetwork?: boolean;
  /** Network is denied except outbound to this one loopback port (a session gateway's). */
  allowLoopbackPort?: number;
  /** Optional Unix socket directory; it must resolve inside a writable root. */
  unixSocketRoot?: string;
}

function checkPath(path: string): void {
  if (!isAbsolute(path) || /["\\\n\r\0]/.test(path)) {
    throw new RangeError(`sandbox path must be absolute and free of quotes, backslashes and newlines: ${JSON.stringify(path)}`);
  }
}

function resolved(path: string): string {
  checkPath(path);
  try {
    return realpathSync(path);
  } catch {
    throw new RangeError(`sandbox path does not exist: ${path}`);
  }
}

/** The seatbelt profile text. Later rules win, so the denials come after `allow default`. */
export function buildProfile(profile: SandboxProfile): string {
  if (profile.writableRoots.length === 0) throw new RangeError("a sandbox profile needs at least one writable root");
  const port = profile.allowLoopbackPort;
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`allowLoopbackPort must be an integer port 1..65535: ${port}`);
    if (profile.allowNetwork) throw new RangeError("allowLoopbackPort and allowNetwork cannot be combined");
  }
  const writablePaths = profile.writableRoots.map((path) => ({ logical: resolve(path), physical: resolved(path) }));
  const writable = [...new Set(writablePaths.map(({ physical }) => physical))];
  const denied = [...new Set((profile.denyReadRoots ?? []).map(resolved))];
  const unixRoot = profile.unixSocketRoot === undefined ? undefined : (() => {
    const path = profile.unixSocketRoot!;
    const physical = resolved(path);
    const logical = resolve(path);
    const root = writablePaths.find((w) => {
      const subpath = relative(w.logical, logical);
      return !isAbsolute(subpath) && subpath !== ".." && !subpath.startsWith(`..${sep}`) &&
        join(w.physical, subpath) === physical;
    });
    if (!root) throw new RangeError(`Unix socket root is outside or resolves away from the writable root: ${path}`);
    // Use the host-selected path, not a newly resolved symlink target, in the resulting policy.
    return join(root.physical, relative(root.logical, logical));
  })();
  if (unixRoot && profile.allowNetwork) throw new RangeError("unixSocketRoot cannot be combined with allowNetwork");
  if (unixRoot && !statSync(unixRoot).isDirectory()) throw new RangeError(`Unix socket root is not a directory: ${unixRoot}`);
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writable.map((root) => `(subpath "${root}")`).join(" ")} (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys[0-9]+$"))`,
  ];
  if (!profile.allowNetwork) lines.push("(deny network*)");
  if (port !== undefined) lines.push(`(allow network-outbound (remote ip "localhost:${port}"))`);
  if (unixRoot) {
    lines.push("(allow system-socket (socket-domain AF_UNIX))");
    lines.push(`(allow network-bind (local unix-socket (subpath "${unixRoot}")))`);
    lines.push(`(allow network-outbound (remote unix-socket (subpath "${unixRoot}")))`);
  }
  for (const root of denied) lines.push(`(deny file-read* (subpath "${root}"))`);
  return lines.join("\n");
}

export function sandboxCommand(profile: SandboxProfile, argv: string[], binary: string = SANDBOX_BINARY): string[] {
  return [binary, "-p", buildProfile(profile), ...argv];
}

const ENV_ALLOW = ["PATH", "LANG", "LC_ALL", "TERM"];

/** The only environment a session's tools get: no tokens, no `ANIMA_*`, HOME and TMPDIR inside the work root. */
export function sanitizedEnv(parent: Record<string, string | undefined>, paths: { home: string; tmp: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOW) if (parent[key] !== undefined) env[key] = parent[key]!;
  env.HOME = paths.home;
  env.TMPDIR = paths.tmp;
  return env;
}

export type ProbeResult = { ok: true } | { ok: false; reason: string };

/**
 * Proves the boundary on this host: a write inside the root works; a write outside it and a write
 * through a symlink that points outside are both refused and leave nothing behind.
 */
export function probeSandbox(options: { binary?: string } = {}): ProbeResult {
  const binary = options.binary ?? SANDBOX_BINARY;
  if (!existsSync(binary)) return { ok: false, reason: `isolation unavailable: ${binary} not found` };

  const base = realpathSync(mkdtempSync(join(tmpdir(), "work-probe-")));
  try {
    const root = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, join(root, "link"));
    const profile = buildProfile({ writableRoots: [root] });
    const sh = (script: string) =>
      Bun.spawnSync([binary, "-p", profile, "sh", "-c", script], { cwd: root, env: { PATH: "/usr/bin:/bin" } }).exitCode;

    if (sh("echo ok > inside.txt") !== 0 || !existsSync(join(root, "inside.txt"))) {
      return { ok: false, reason: "isolation unavailable: a write inside the work root failed under the profile" };
    }
    sh(`echo x > ${outside}/direct.txt`);
    if (existsSync(join(outside, "direct.txt"))) return { ok: false, reason: "isolation unavailable: a write outside the work root succeeded" };
    sh("echo x > link/viaLink.txt");
    if (existsSync(join(outside, "viaLink.txt"))) return { ok: false, reason: "isolation unavailable: a write through a symlink succeeded" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `isolation unavailable: probe failed (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/*
 * Run the listeners in a separate Bun process. All addresses are disposable, and the child has no credentials.
 */
const WORK_UNIX_PROBE = String.raw`
const { symlinkSync, linkSync, renameSync } = require("node:fs");
const { join } = require("node:path");
const root = process.env.PROBE_ROOT, outside = process.env.PROBE_OUTSIDE;
const binary = process.env.PROBE_BINARY, profile = process.env.PROBE_PROFILE;
const inner = join(root, "tmp", "i"), outer = join(outside, "o");
const symlink = join(root, "tmp", "s"), hardlink = join(root, "tmp", "h");
const live = [];
async function call(args, confined) {
  const argv = ["/usr/bin/curl", "-sS", "--max-time", "2", ...args];
  const p = Bun.spawn(confined ? [binary, "-p", profile, ...argv] : argv,
    { stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } });
  const [code, text] = await Promise.all([p.exited, new Response(p.stdout).text()]);
  return { code, text };
}
async function run() {
  live.push(Bun.serve({ unix: inner, fetch: () => new Response("inside") }));
  live.push(Bun.serve({ unix: outer, fetch: () => new Response("outside") }));
  const tcp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("tcp") });
  live.push(tcp);
  symlinkSync(outer, symlink);
  linkSync(outer, hardlink);
  const unix = p => ["--unix-socket", p, "http://localhost/"];
  if ((await call(unix(inner), true)).text !== "inside") throw Error("local Unix connect failed");
  for (const p of [outer, symlink, hardlink]) {
    if ((await call(unix(p), false)).text !== "outside") throw Error("outside Unix control failed");
    if ((await call(unix(p), true)).code === 0) throw Error("outside Unix socket reachable");
  }
  const url = ["http://127.0.0.1:" + tcp.port + "/"];
  if ((await call(url, false)).text !== "tcp") throw Error("TCP control failed");
  if ((await call(url, true)).code === 0) throw Error("TCP reachable");
  const bindScript = "const n=require('node:net');const p=process.env.PROBE_SOCKET;const s=n.createServer(c=>c.end('bound'));s.on('error',()=>process.exit(2));s.listen(p,()=>{const c=n.connect(p);c.on('data',d=>{console.log(String(d));s.close()});c.on('error',()=>process.exit(3))});setTimeout(()=>process.exit(4),1500).unref()";
  const p = Bun.spawn([binary, "-p", profile, process.execPath, "-e", bindScript], {
    stdout: "pipe", stderr: "ignore",
    env: { PATH: "/usr/bin:/bin", PROBE_SOCKET: join(root, "tmp", "b") }
  });
  const [code, text] = await Promise.all([p.exited, new Response(p.stdout).text()]);
  if (code !== 0 || text.trim() !== "bound") throw Error("local Unix bind failed");
  const other = join(root, "tree", "other");
  live.push(Bun.serve({ unix: other, fetch: () => new Response("other") }));
  renameSync(join(root, "tmp"), join(root, "tmp-old"));
  symlinkSync(join(root, "tree"), join(root, "tmp"));
  const swapped = unix(join(root, "tmp", "other"));
  if ((await call(swapped, false)).text !== "other") throw Error("swapped directory control failed");
  if ((await call(swapped, true)).code === 0) throw Error("swapped directory escaped Unix scope");
  process.stdout.write("ok");
}
try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  for (const server of live) server.stop(true);
}
`;

/**
 * Check the exact work-tool socket policy against real listeners and alias paths on this host. A missing tool,
 * timeout, unexpected output or unenforced boundary all fail closed; no network service is contacted.
 */
export async function probeWorkUnixSockets(options: { binary?: string; timeoutMs?: number } = {}): Promise<ProbeResult> {
  const binary = options.binary ?? SANDBOX_BINARY;
  if (!existsSync(binary)) return { ok: false, reason: `isolation unavailable: ${binary} not found` };
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    return { ok: false, reason: "isolation unavailable: Unix socket probe timeout must be between 1 and 10000 ms" };
  }
  let base: string | undefined;
  try {
    base = realpathSync(mkdtempSync(join(tmpdir(), "work-unix-")));
    const root = join(base, "r");
    const outside = join(base, "o");
    mkdirSync(join(root, "tmp"), { recursive: true });
    mkdirSync(join(root, "tree"), { recursive: true });
    mkdirSync(outside);
    const profile = buildProfile({ writableRoots: [root], unixSocketRoot: join(root, "tmp") });
    const child = Bun.spawn([process.execPath, "-e", WORK_UNIX_PROBE], {
      env: { PATH: "/usr/bin:/bin", PROBE_ROOT: root, PROBE_OUTSIDE: outside, PROBE_BINARY: binary, PROBE_PROFILE: profile },
      detached: true,
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {
        try { child.kill("SIGKILL"); } catch { /* already stopped */ }
      }
    }, timeoutMs);
    let exitCode: number, stdout: string, stderr: string;
    try {
      [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) return { ok: false, reason: "isolation unavailable: Unix socket probe timed out" };
    if (exitCode !== 0 || stdout !== "ok") {
      const detail = stderr.trim().slice(0, 200) || "probe did not complete";
      return { ok: false, reason: `isolation unavailable: Unix socket boundary: ${detail}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `isolation unavailable: Unix socket probe failed (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    if (base) rmSync(base, { recursive: true, force: true });
  }
}

/**
 * Proves the loopback-only boundary on this host with real listeners: under a profile granting one listener's
 * port, a sandboxed curl reaches it and is refused for another loopback listener, a Unix socket listener and an
 * internet address. Any other outcome means isolation is unavailable.
 */
export async function probeLoopbackOnly(options: { binary?: string } = {}): Promise<ProbeResult> {
  const binary = options.binary ?? SANDBOX_BINARY;
  if (!existsSync(binary)) return { ok: false, reason: `isolation unavailable: ${binary} not found` };

  const base = realpathSync(mkdtempSync(join(tmpdir(), "work-probe-net-")));
  const serve = (where: { port: 0 } | { unix: string }) =>
    Bun.serve({ ...("unix" in where ? { unix: where.unix } : { hostname: "127.0.0.1", port: 0 }), fetch: () => new Response("ok") });
  const granted = serve({ port: 0 });
  const other = serve({ port: 0 });
  const socket = join(base, "probe.sock");
  const unix = serve({ unix: socket });
  try {
    const profile = buildProfile({ writableRoots: [base], allowLoopbackPort: granted.port! });
    const curl = async (args: string[]) => {
      const child = Bun.spawn([binary, "-p", profile, "/usr/bin/curl", "-s", "-m", "3", "-o", "/dev/null", ...args], {
        cwd: base, env: { PATH: "/usr/bin:/bin" }, stdout: "ignore", stderr: "ignore",
      });
      return await child.exited;
    };
    if (await curl([`http://127.0.0.1:${granted.port}/`]) !== 0) return { ok: false, reason: "isolation unavailable: the granted loopback port was not reachable" };
    if (await curl([`http://127.0.0.1:${other.port}/`]) === 0) return { ok: false, reason: "isolation unavailable: another loopback port was reachable" };
    if (await curl(["--unix-socket", socket, "http://localhost/"]) === 0) return { ok: false, reason: "isolation unavailable: a Unix socket was reachable" };
    if (await curl(["http://1.1.1.1/"]) === 0) return { ok: false, reason: "isolation unavailable: the internet was reachable" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `isolation unavailable: probe failed (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    granted.stop(true);
    other.stop(true);
    unix.stop(true);
    rmSync(base, { recursive: true, force: true });
  }
}
