import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const owned: string[] = [];
const env = { PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR ?? "/tmp", NO_COLOR: "1" };
function directory() { const dir = mkdtempSync(join(tmpdir(), "anima-runtime-manifest-")); owned.push(dir); return dir; }
function prepare(source: string, target: string) {
  const run = Bun.spawnSync([process.execPath, join(root, "scripts/prepare-runtime-manifest.ts"), source, join(target, "package.json")], { env });
  expect({ exit: run.exitCode, stderr: run.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
  return JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
}
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("RL-1 regression: deployed real manifest has no checkout skill lifecycle", () => {
  const deployed = prepare(join(root, "package.json"), directory());
  expect(deployed.scripts.postinstall).toBeUndefined();
  expect(Object.keys(deployed.scripts).filter(key => key.startsWith("skills:"))).toEqual([]);
  const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(source.scripts.postinstall).toBe("bun run skills:sync");
});

test("RL-2 regression: actual production install succeeds without source skill scripts", () => {
  const checkout = directory(), runtime = directory();
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "runtime-install-fixture", private: true,
    scripts: { postinstall: "bun run skills:sync", "skills:sync": "bun scripts/sync-skills.ts", "skills:check": "bun scripts/sync-skills.ts --check", start: "bun dist/server.js" } }));
  prepare(join(checkout, "package.json"), runtime);
  expect(existsSync(join(runtime, "scripts"))).toBe(false);
  const install = Bun.spawnSync([process.execPath, "install", "--production"], { cwd: runtime, env, timeout: 20_000 });
  expect({ exit: install.exitCode, output: install.stdout.toString() + install.stderr.toString() })
    .toMatchObject({ exit: 0 });
}, 30_000);

test("RL-3: drops every source skills command while preserving unrelated scripts and input", () => {
  const checkout = directory(), runtime = directory();
  const source = { name: "manifest-fixture", private: true, scripts: { postinstall: "bun run skills:sync", "skills:future": "bun scripts/next.ts", start: "bun dist/server.js", doctor: "bun dist/doctor.js" } };
  const original = JSON.stringify(source); writeFileSync(join(checkout, "package.json"), original);
  const deployed = prepare(join(checkout, "package.json"), runtime);
  expect(deployed.scripts).toEqual({ start: source.scripts.start, doctor: source.scripts.doctor });
  expect(readFileSync(join(checkout, "package.json"), "utf8")).toBe(original);
});

test("RL-4: manifest without scripts remains without scripts", () => {
  const checkout = directory(), runtime = directory();
  writeFileSync(join(checkout, "package.json"), '{"name":"no-scripts-fixture","private":true}');
  expect(prepare(join(checkout, "package.json"), runtime).scripts).toBeUndefined();
});
