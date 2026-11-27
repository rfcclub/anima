import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let implementation: Record<string, any> = {};
try { implementation = await import("../../src/work/progress-state"); } catch { /* initial RED */ }
const dirs: string[] = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "progress-state-")); dirs.push(root);
  const tree = join(root, "tree"), gitDir = join(root, "git"), home = join(root, "home"), tmp = join(root, "tmp");
  mkdirSync(home); mkdirSync(tmp);
  const init = Bun.spawnSync(["git", "init", "-q", `--separate-git-dir=${gitDir}`, tree]);
  if (init.exitCode !== 0) throw new Error("git init failed");
  writeFileSync(join(tree, "tracked.txt"), "one");
  if (Bun.spawnSync(["git", "-C", tree, "add", "tracked.txt"]).exitCode !== 0) throw new Error("git add failed");
  if (Bun.spawnSync(["git", "-C", tree, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]).exitCode !== 0) throw new Error("git commit failed");
  return { root, tree, gitDir, home, tmp, branch: "master", created: true };
}
async function sample(ws: ReturnType<typeof workspace>, signal = new AbortController().signal) {
  expect(typeof implementation.fingerprintWorkState).toBe("function");
  return implementation.fingerprintWorkState({ workspace: ws, denyReadRoots: [], signal, parentEnv: process.env });
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("progress state fingerprint", () => {
  test("detects same-size changes to tracked and nonignored untracked files", async () => {
    const ws = workspace();
    const first = await sample(ws); expect(first).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(ws.tree, "tracked.txt"), "two");
    const second = await sample(ws); expect(second).not.toBe(first);
    writeFileSync(join(ws.tree, "untracked.txt"), "abc");
    const third = await sample(ws); expect(third).not.toBe(second);
    writeFileSync(join(ws.tree, "untracked.txt"), "def");
    expect(await sample(ws)).not.toBe(third);
  });

  test("does not follow a worktree symlink to an outside file", async () => {
    const ws = workspace(); const outside = join(ws.root, "outside.txt");
    writeFileSync(outside, "first"); symlinkSync(outside, join(ws.tree, "link"));
    const first = await sample(ws); expect(first).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(outside, "changed");
    expect(await sample(ws)).toBe(first);
  });

  test("returns unknown for an oversized or aborted snapshot", async () => {
    const ws = workspace(); writeFileSync(join(ws.tree, "large.bin"), Buffer.alloc(9 * 1024 * 1024));
    expect(await sample(ws)).toBeNull();
    const controller = new AbortController(); controller.abort();
    expect(await sample(ws, controller.signal)).toBeNull();
  });
});
