/**
 * castle-work-loop, WL-8: no test of the work loop may reach a model, GitHub or a Mesh gateway, and
 * the pieces that can do so are confined to the two modules that wire real dependencies.
 */

import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (dir: string) => readdirSync(join(root, dir), { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".ts"))
  .map((e) => ({ name: `${dir}/${e.name}`, text: readFileSync(join(root, dir, e.name), "utf-8") }));

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("no work-loop test names a real API host, fetches a literal URL or spawns gh", () => {
  const forbidden = [/api\.github\.com/, /api\.anthropic\.com/, /api\.openai\.com/, /agnes[^"'\s]*\.(com|ai|io)/i, /[^.\w]fetch\(\s*["'`]https?:/, /Bun\.spawn(?:Sync)?\(\s*\[\s*["']gh["']/];
  const own = read("__tests__/work").filter((f) => !f.name.endsWith("no-live-calls.test.ts"));
  expect(own.length).toBeGreaterThan(10);
  for (const file of own) for (const pattern of forbidden) {
    expect({ file: file.name, hit: pattern.test(strip(file.text)) }).toEqual({ file: file.name, hit: false });
  }
});

test("only production.ts and gh-adapter.ts in src/work reach for gh, the real provider factory or process.env credentials", () => {
  const allowed = new Set(["src/work/production.ts", "src/work/gh-adapter.ts"]);
  for (const file of read("src/work")) {
    if (allowed.has(file.name)) continue;
    const text = strip(file.text);
    expect({ file: file.name, spawnsGh: /spawnGh|["']gh["']/.test(text) }).toEqual({ file: file.name, spawnsGh: false });
    expect({ file: file.name, providerFactory: /createProviderForType/.test(text) }).toEqual({ file: file.name, providerFactory: false });
  }
});

test("the work loop is off unless a work block says enabled: true", () => {
  const start = strip(readFileSync(join(root, "src/mesh-jobs/start.ts"), "utf-8"));
  expect(start).toContain("if (!config.work)");
  const config = strip(readFileSync(join(root, "src/mesh-jobs/config.ts"), "utf-8"));
  expect(config).toContain("raw.enabled !== true");
});
