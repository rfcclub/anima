import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const root = join(import.meta.dir, "../..");
function source(path: string) { return readFileSync(join(root, path), "utf8"); }
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}

for (const file of ["src/memory/bodega-adapter.ts", "src/providers/claude.ts", "src/ui/server.ts"]) {
  test(`D1/D4 regression: remove inventoried dead file ${file}`, () => {
    expect({ file, exists: existsSync(join(root, file)) }).toEqual({ file, exists: false });
  });
}

test("D1/D4 regression: removed modules have no source consumers and UI script uses its real entrypoint", () => {
  const removed = new Set(["src/memory/bodega-adapter", "src/providers/claude", "src/ui/server"].map(p => resolve(root, p)));
  const remaining = ["src", "test", "__tests__", "scripts", "packages"].flatMap(dir => files(join(root, dir)))
    .filter(file => /\.[cm]?[jt]sx?$/.test(file))
    .flatMap(file => [...readFileSync(file, "utf8").matchAll(/(?:\bfrom\s*|\b(?:import|require)\s*\(\s*|\bimport\s*)["']([^"']+)["']/g)]
      .filter(match => match[1].startsWith(".") && removed.has(resolve(dirname(file), match[1]).replace(/\.[cm]?[jt]sx?$/, "")))
      .map(match => `${relative(root, file)} -> ${match[1]}`));
  expect(remaining).toEqual([]);
  expect(JSON.parse(source("package.json")).scripts["start:ui-only"]).toBe("bun src/ui/app/server.ts");
});

test("D2 regression: the public alias has one executor dispatch case", () => {
  expect(source("src/tools/executor.ts").match(/case "anima_list_all"/g)).toHaveLength(1);
});

test("D5 regression: no inline cost UI", () => {
  expect(source("src/server.ts").includes("serveCostPage")).toBe(false);
});

test("D7 regression: one activation environment read", () => {
  expect(source("src/server.ts").match(/Bun\.env\.ANIMA_ACTIVATION_MODE/g)).toHaveLength(1);
});

for (const mode of ["health", "http"]) {
  test(`D${mode === "health" ? "6" : "4/D5"} regression: real ${mode} process boundary`, async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/runtime-probe.ts"), mode], {
      cwd: root, stdout: "pipe", stderr: "pipe", timeout: 15_000,
      // No provider credentials or operator configuration reach this fixture.
      env: { PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR ?? "/tmp", TZ: "UTC", NODE_ENV: "test" },
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ exit, stdout, stderr }).toMatchObject({ exit: 0 });
    const receipt = JSON.parse(stdout.trim().split("\n").at(-1)!);
    if (mode === "health") {
      expect(receipt).toMatchObject({ registrations: 1, stores: 1, tempOnly: true });
    } else {
      expect(receipt).toMatchObject({ defaultStatus: 302, configuredStatus: 302, disabledStatus: 503, proxyStatus: 503, uiStatus: 200, listenerClosed: true });
    }
  }, 20_000);
}
