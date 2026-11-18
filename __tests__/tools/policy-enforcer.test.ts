import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPolicy, isPathInside } from "../../src/tools/policy-enforcer";
import type { ToolPolicy } from "../../src/config/types";

let base: string;
let allowed: string;
let readOnly: string;
let outside: string;
let policy: ToolPolicy;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "policy-")));
  allowed = join(base, "allowed");
  readOnly = join(base, "ro");
  outside = join(base, "outside");
  for (const d of [allowed, readOnly, outside]) mkdirSync(d);
  symlinkSync(outside, join(allowed, "escape"));
  policy = { allowedRoots: [allowed], readOnlyRoots: [readOnly], deniedPatterns: ["rm\\s+-rf", "\\.ssh"] };
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const check = (tool: string, args: Record<string, unknown>, cwd = allowed) =>
  checkPolicy({ tool, args, policy, cwd });

describe("isPathInside", () => {
  test("root itself and children are inside, siblings and prefixes are not", () => {
    expect(isPathInside("/a/b", "/a/b")).toBe(true);
    expect(isPathInside("/a/b", "/a/b/c")).toBe(true);
    expect(isPathInside("/a/b", "/a/bc")).toBe(false);
    expect(isPathInside("/a/b", "/a")).toBe(false);
  });
});

describe("checkPolicy", () => {
  test("SC-1 read under an allowed root is allowed", () => {
    expect(check("read", { path: join(allowed, "f.txt") }).allowed).toBe(true);
  });
  test("SC-1 relative path inside a root is allowed", () => {
    expect(check("read", { path: "f.txt" }).allowed).toBe(true);
  });
  test("SC-2 read/grep/glob outside roots are denied", () => {
    for (const [tool, args] of [
      ["read", { path: join(outside, "f") }],
      ["grep", { pattern: "x", path: outside }],
      ["glob", { pattern: "*", cwd: outside }],
    ] as const) {
      const d = check(tool, args as Record<string, unknown>);
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.rule).toBe("outside-roots");
    }
  });
  test("SC-2 read inside a readOnlyRoot is allowed", () => {
    expect(check("read", { path: join(readOnly, "f") }).allowed).toBe(true);
  });
  test("SC-3 write/edit inside a readOnlyRoot is denied", () => {
    for (const tool of ["write", "edit"]) {
      const d = check(tool, { path: join(readOnly, "f") });
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.rule).toBe("read-only-root");
    }
  });
  test("SC-4 ../ traversal out of every root is denied", () => {
    expect(check("read", { path: "../outside/f" }).allowed).toBe(false);
  });
  test("SC-5 symlink inside a root pointing outside is denied", () => {
    expect(check("read", { path: join(allowed, "escape", "f") }).allowed).toBe(false);
    expect(check("write", { path: join(allowed, "escape", "new.txt") }).allowed).toBe(false);
  });
  test("SC-6 write to a new file under an allowed root is allowed", () => {
    expect(check("write", { path: join(allowed, "deep", "new", "f.txt") }).allowed).toBe(true);
  });
  test("SC-7 bash matching a deniedPattern is denied", () => {
    const d = check("bash", { command: "cat ~/.ssh/id_ed25519" });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.rule).toBe("denied-pattern");
  });
  test("SC-7 bash not matching is allowed", () => {
    expect(check("bash", { command: "ls -la" }).allowed).toBe(true);
  });
  test("SC-8 bash with cwd outside allowedRoots is denied", () => {
    const d = check("bash", { command: "ls" }, outside);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.rule).toBe("cwd-outside-roots");
  });
  test("SC-9 non-path tools are allowed", () => {
    expect(check("mesh_send", { to_id: "x" }).allowed).toBe(true);
    expect(check("anima_recall", {}).allowed).toBe(true);
  });
  test("task checks its tasks.md under cwd", () => {
    expect(check("task", { action: "list" }).allowed).toBe(true);
    expect(check("task", { action: "list" }, outside).allowed).toBe(false);
  });
  test("an invalid deniedPattern regex falls back to substring match", () => {
    const p: ToolPolicy = { allowedRoots: [allowed], deniedPatterns: ["(unclosed"] };
    const d = checkPolicy({ tool: "bash", args: { command: "echo (unclosed" }, policy: p, cwd: allowed });
    expect(d.allowed).toBe(false);
  });
});
