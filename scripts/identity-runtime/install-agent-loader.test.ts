import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL = join(import.meta.dir, "install-agent-loader.sh");
const LOADER = join(import.meta.dir, "agent-loader.sh");

async function install(dir: string) {
  const proc = Bun.spawn(["sh", INSTALL], { env: { ...process.env, AGENT_LOADER_INSTALL_DIR: dir }, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { stderr, code };
}

test("creates the directory and a symlink to agent-loader.sh", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "install-")), "scripts");
  expect((await install(dir)).code).toBe(0);
  expect(readlinkSync(join(dir, "agent-loader"))).toBe(LOADER);
});

test("is idempotent and repoints a stale symlink", async () => {
  const dir = mkdtempSync(join(tmpdir(), "install-"));
  symlinkSync("/nonexistent/old-agent-loader.sh", join(dir, "agent-loader"));
  expect((await install(dir)).code).toBe(0);
  expect((await install(dir)).code).toBe(0);
  expect(readlinkSync(join(dir, "agent-loader"))).toBe(LOADER);
});

test("refuses to overwrite a regular file and leaves it untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "install-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent-loader"), "MINE");
  const result = await install(dir);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("not a symlink");
  expect(lstatSync(join(dir, "agent-loader")).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(dir, "agent-loader"), "utf8")).toBe("MINE");
});
