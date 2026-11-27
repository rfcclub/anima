import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "..", "scripts", "hindsight-wrapup.ts");

const complete = [
  "## Decisions made and why",
  "- One document per session, keyed by session id.",
  "## What shipped",
  "- #674.",
  "## Open work",
  "- None.",
  "## Owner corrections",
  "- None.",
  "## Claims needing verification",
  "- None.",
].join("\n");

function run(args: string[], input?: string) {
  const home = mkdtempSync(join(tmpdir(), "wrapup-home-"));
  return spawnSync("bun", [script, ...args], {
    input: input ?? "",
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

describe("hindsight-wrapup CLI", () => {
  test("prints the fixed sections and exits 2 without a bank or session", () => {
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("## Decisions made and why");
    expect(result.stderr).toContain("## Claims needing verification");
  });

  test("exits 1 on an incomplete wrap-up instead of writing a partial record", () => {
    const result = run(["--bank", "b", "--session", "s"], "## Decisions made and why\n- x\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing or empty section");
  });

  test("an unreadable --file is a structured outcome, not an uncaught throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "wrapup-doc-"));
    const missing = join(dir, "absent.md");
    const result = run(["--bank", "b", "--session", "s", "--file", missing]);
    expect(result.status).toBe(1);
    // The CLI documents one JSON outcome per run: no stack trace on stderr.
    expect(result.stderr).not.toContain("ENOENT");
    expect(result.stderr).not.toContain("    at ");
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ outcome: "error", reason: "file-unreadable" });
  });

  test("reports config-unavailable rather than throwing when no Hindsight config exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "wrapup-doc-"));
    const file = join(dir, "wrapup.md");
    writeFileSync(file, complete);
    const result = run(["--bank", "b", "--session", "s", "--file", file]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ outcome: "error", documentId: "wrapup-s" });
  });
});
