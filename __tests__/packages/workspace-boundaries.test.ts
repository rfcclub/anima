import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "../..");

test("WP-1: installation links every workspace to its own manifest identity", () => {
  for (const name of readdirSync(join(root, "packages"))) {
    const directory = join(root, "packages", name);
    const manifest = join(directory, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    expect(realpathSync(join(root, "node_modules", pkg.name))).toBe(realpathSync(directory));
  }
});

test("WP-1: public package imports expose the real consumed functions", async () => {
  const context = await import("@anima/context-engine");
  const continuity = await import("@anima/continuity-core");
  const roster = await import("@anima/identity-runtime/roster");
  expect(context.estimateTokens("a small fixture")).toBeGreaterThan(0);
  expect(typeof continuity.LeaseStore).toBe("function");
  expect(typeof roster.readRosterAgentIds).toBe("function");
});

test("WP-2: root source does not reach through relative package internals", () => {
  const offenders: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name) &&
        /["'](?:\.\.\/)+packages\//.test(readFileSync(path, "utf8"))) {
        offenders.push(relative(root, path));
      }
    }
  }
  walk(join(root, "src"));
  expect(offenders).toEqual([]);
});

test("WP-2: TypeScript accepts a public import but rejects a real unexported internal path", () => {
  const directory = mkdtempSync(join(root, ".tmp-workspace-"));
  try {
    const file = join(directory, "contract.ts");
    function compile(source: string) {
      writeFileSync(file, source);
      return Bun.spawnSync([
        process.execPath, join(root, "node_modules/typescript/bin/tsc"),
        "--noEmit", "--skipLibCheck", "--moduleResolution", "bundler",
        "--module", "esnext", "--target", "ES2022", "--types", "bun-types",
        "--allowImportingTsExtensions", "--customConditions", "bun", file,
      ], { cwd: root, timeout: 20_000 });
    }
    const valid = compile('import type { ContextEngine } from "@anima/context-engine"; export type Contract = ContextEngine;');
    expect({ exit: valid.exitCode, output: valid.stdout.toString() + valid.stderr.toString() })
      .toEqual({ exit: 0, output: "" });
    expect(existsSync(join(root, "packages/context-engine/src/types.ts"))).toBe(true);
    const invalid = compile('import type { ContextEngine } from "@anima/context-engine/src/types.js"; export type Contract = ContextEngine;');
    expect(invalid.exitCode).not.toBe(0);
    const errors = (invalid.stdout.toString() + invalid.stderr.toString())
      .split(/\r?\n/).filter((line) => line.includes("error TS"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("TS2307");
    expect(errors[0]).toContain("@anima/context-engine/src/types.js");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);

test("WP-1: Mesh dependency is pinned to a Git commit without a sibling checkout", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg.dependencies["colony-mesh"]).toMatch(/^git\+ssh:\/\/git@github\.com\/rfcclub\/colony-mesh\.git#[0-9a-f]{40}$/);
});

test("WP-3: deployment stages an installable bundle manifest without source workspaces", () => {
  const directory = mkdtempSync(join(root, ".tmp-workspace-deploy-"));
  try {
    const script = readFileSync(join(root, "scripts/deploy.sh"), "utf8");
    const block = script.split("# package.json + node_modules for bun runtime\n")[1]?.split("# 3. Install deps")[0];
    expect(block).toBeDefined();
    const result = Bun.spawnSync(["bash", "-euc", block!], {
      cwd: directory, env: { ...process.env, PROJECT_DIR: root, ANIMA_HOME: directory },
    });
    expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
    const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const deployed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    expect(deployed.workspaces).toBeUndefined();
    expect(Object.values(deployed.dependencies).some((value: any) => value.startsWith("workspace:"))).toBe(false);
    expect(deployed.dependencies["colony-mesh"]).toBe(source.dependencies["colony-mesh"]);
    expect(deployed.dependencies.react).toBe(source.dependencies.react);
    expect(source.workspaces).toEqual(["packages/*"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
