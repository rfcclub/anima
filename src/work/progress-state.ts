import { sandboxCommand, sanitizedEnv } from "./sandbox";
import type { Workspace } from "./workspace";

/**
 * Runs in a sandboxed child, so inspecting worker-controlled paths cannot acquire more read authority than the
 * worker. Git lists tracked and nonignored files; links are hashed as links, never followed. Limits make an
 * incomplete snapshot unknown rather than an apparent match.
 */
const SNAPSHOT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const [root, tree, gitDir] = process.argv.slice(1);
const fail = () => { process.exitCode = 1; };
try {
  const canonicalRoot = fs.realpathSync(root);
  if (fs.realpathSync(tree) !== path.join(canonicalRoot, "tree") || fs.realpathSync(gitDir) !== path.join(canonicalRoot, "git")) throw Error("redirected workspace");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  const common = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "core.attributesFile=/dev/null", "--git-dir", gitDir, "--work-tree", tree];
  const git = (args) => {
    const out = cp.spawnSync("git", [...common, ...args], { cwd: tree, env, maxBuffer: 8 * 1024 * 1024 });
    if (out.status !== 0 || out.error) throw Error("git inspection failed");
    return out.stdout;
  };
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]).toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw Error("invalid head");
  const stage = git(["ls-files", "--stage", "-z"]);
  const other = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  const decode = (buffer) => new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  const records = (buffer) => {
    if (!buffer.length) return [];
    if (buffer[buffer.length - 1] !== 0) throw Error("incomplete file list");
    return decode(buffer).slice(0, -1).split("\0");
  };
  const files = new Set();
  for (const record of records(stage)) {
    const match = /^([0-7]{6}) [0-9a-f]{40,64} ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match || match[2] !== "0" || match[1] === "160000") throw Error("unsupported index entry");
    files.add(match[3]);
  }
  for (const name of records(other)) files.add(name);
  if (files.size > 5000) throw Error("too many files");
  const hash = crypto.createHash("sha256");
  const field = (value) => { const b = Buffer.isBuffer(value) ? value : Buffer.from(String(value)); hash.update(String(b.length) + ":"); hash.update(b); };
  field(head); field(stage);
  let total = 0;
  for (const name of [...files].sort()) {
    const pieces = name.split("/");
    if (!name || path.isAbsolute(name) || pieces.some((part) => !part || part === "." || part === "..")) throw Error("invalid path");
    field(name);
    let current = tree;
    for (let index = 0; index < pieces.length - 1; index++) {
      current = path.join(current, pieces[index]);
      const parent = fs.lstatSync(current);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error("unsafe parent");
    }
    const file = path.join(current, pieces[pieces.length - 1]);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") { field("missing"); continue; } throw error; }
    if (stat.isSymbolicLink()) { field("link"); field(fs.readlinkSync(file)); continue; }
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw Error("unsupported file");
    total += stat.size;
    if (total > 64 * 1024 * 1024) throw Error("snapshot too large");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size) throw Error("file changed");
      field("file"); field(before.mode); field(before.size);
      const buffer = Buffer.allocUnsafe(65536);
      let read = 0;
      while (read < before.size) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - read), null);
        if (!count) throw Error("short read");
        hash.update(buffer.subarray(0, count)); read += count;
      }
      const after = fs.fstatSync(fd);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error("file changed");
    } finally { fs.closeSync(fd); }
  }
  process.stdout.write(hash.digest("hex"));
} catch { fail(); }
`;

export async function fingerprintWorkState(input: {
  workspace: Workspace;
  denyReadRoots: string[];
  signal: AbortSignal;
  parentEnv: Record<string, string | undefined>;
}): Promise<string | null> {
  if (input.signal.aborted) return null;
  const { workspace: ws } = input;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted = false;
  const stop = () => {
    aborted = true;
    if (!child) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  };
  try {
    const argv = sandboxCommand({ writableRoots: [ws.root], denyReadRoots: input.denyReadRoots }, [process.execPath, "-e", SNAPSHOT, ws.root, ws.tree, ws.gitDir]);
    child = Bun.spawn(argv, { cwd: ws.tree, env: sanitizedEnv(input.parentEnv, { home: ws.home, tmp: ws.tmp }), detached: true, stdout: "pipe", stderr: "ignore" });
    input.signal.addEventListener("abort", stop, { once: true });
    if (input.signal.aborted) stop();
    timer = setTimeout(stop, 5_000);
    const stdout = child.stdout;
    if (!stdout || typeof stdout === "number") throw new Error("snapshot output unavailable");
    const [code, output] = await Promise.all([child.exited, new Response(stdout).text()]);
    return !aborted && code === 0 && /^[0-9a-f]{64}$/.test(output) ? output : null;
  } catch {
    stop();
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    input.signal.removeEventListener("abort", stop);
  }
}
