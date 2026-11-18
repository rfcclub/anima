import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const tracked = () => execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
test("RH-1 regression: generated and runtime artifacts are absent from index", () => {
  const artifacts = tracked().filter(p => (p.startsWith("graphify-out/") && p !== "graphify-out/GRAPH_REPORT.md") ||
    p.startsWith("_archive/") || p.startsWith("state/") || /\.tsbuildinfo$|\.bak|\.tar\.gz$/.test(p) || p === ".qwen-review-output.json");
  expect(artifacts).toEqual([]);
});
test("RH-2: ignore rules cover artifacts and generated skills but preserve graph report", () => {
  const samples = ["graphify-out/graph.json", "_archive/anything.txt", "state/new.json", "pkg/test.tsbuildinfo", "src/file.bak-1", "pkg/dist.tar.gz", ".qwen-review-output.json", "packages/context-engine/package-lock.json", "packages/openclaw-anima-adapter/pnpm-lock.yaml",
    ...[".agent", ".claude", ".codex", ".factory", ".gemini", ".qwen"].flatMap(a => [`${a}/skills/openspec-explore/SKILL.md`, `${a}/skills/.openspec-sync.json`])];
  const ignored = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: root, input: samples.join("\n") + "\n", encoding: "utf8" }).trim().split("\n");
  expect(ignored).toEqual(samples);
  const report = Bun.spawnSync(["git", "check-ignore", "--no-index", "graphify-out/GRAPH_REPORT.md"], { cwd: root });
  expect(report.exitCode).toBe(1);
});
test("RH-3: only four canonical OpenSpec skills and Bun locks remain tracked", () => {
  const paths = tracked();
  expect(paths.filter(p => /(?:^|\/)openspec-[^/]+\/SKILL.md$/.test(p)).sort()).toEqual(
    ["apply-change", "archive-change", "explore", "propose"].map(n => `skills/openspec-${n}/SKILL.md`).sort());
  expect(paths.filter(p => /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(p))).toEqual([]);
});
test("RH-4: installation and check commands use the same repository skill copier", () => {
  const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;
  expect(scripts["skills:sync"]).toBe("bun scripts/sync-skills.ts");
  expect(scripts["skills:check"]).toBe("bun scripts/sync-skills.ts --check");
  expect(scripts.postinstall).toBe("bun run skills:sync");
});
test("RH-5: deleted generated artifacts use bounded binary diffs while source stays textual", () => {
  const output = execFileSync("git", ["check-attr", "diff", "--", "graphify-out/graph.json", "_archive/example.ts", "state/example.json", "scripts/sync-skills.ts"], { cwd: root, encoding: "utf8" });
  expect(output.trim().split("\n")).toEqual([
    "graphify-out/graph.json: diff: unset", "_archive/example.ts: diff: unset", "state/example.json: diff: unset", "scripts/sync-skills.ts: diff: unspecified"
  ]);
});
