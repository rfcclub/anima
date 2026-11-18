import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const script = resolve(import.meta.dir, "../../.github/scripts/pin-bun-runtime.sh");
function fixture(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "anima-ci-runtime-"));
  try {
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(root, ".bun-version"), Bun.version + "\n");
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function pin(root: string) {
  return Bun.spawnSync(["bash", script, process.execPath], { cwd: root, stdout: "pipe", stderr: "pipe" });
}
test("CI-1 nested scripts use the pinned runtime instead of an uninitialized peer shim", () => fixture(root => {
  const shim = join(root, "peer-shim");
  writeFileSync(shim, "#!/bin/sh\necho LOCAL_PEER_SHIM\nexit 23\n"); chmodSync(shim, 0o755);
  const alias = join(root, "node_modules/.bin/bun");
  symlinkSync(shim, alias);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {
    outer: "bun run inner", inner: "bun -e 'console.log(JSON.stringify({version:Bun.version,exec:process.execPath}))'",
  } }));
  const before = Bun.spawnSync([process.execPath, "run", "outer"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(before.exitCode).toBe(23); expect(before.stdout.toString()).toContain("LOCAL_PEER_SHIM");
  const result = pin(root);
  expect(result.exitCode).toBe(0);
  expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  expect(readlinkSync(alias)).toBe(process.execPath);
  expect(readFileSync(shim, "utf8")).toContain("LOCAL_PEER_SHIM");
  const after = Bun.spawnSync([process.execPath, "run", "outer"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(after.exitCode).toBe(0);
  expect(JSON.parse(after.stdout.toString())).toEqual({ version: Bun.version, exec: process.execPath });
}));
test("CI-1 runtime pin mismatch refuses before replacing a peer alias", () => fixture(root => {
  const alias = join(root, "node_modules/.bin/bun");
  symlinkSync("/missing-peer", alias);
  writeFileSync(join(root, ".bun-version"), "0.0.0\n");
  const result = pin(root);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("runtime version does not match .bun-version");
  expect(readlinkSync(alias)).toBe("/missing-peer");
}));
test("CI-1 runtime pin refuses an unexpected regular file without overwriting it", () => fixture(root => {
  const alias = join(root, "node_modules/.bin/bun");
  writeFileSync(alias, "owned elsewhere");
  const result = pin(root);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("refusing non-symlink Bun alias");
  expect(readFileSync(alias, "utf8")).toBe("owned elsewhere");
  expect(existsSync(process.execPath)).toBe(true);
}));
