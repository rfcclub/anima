import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook, type HookDeps } from "../../../scripts/claude/identity-client";
import { createGuard } from "../../../scripts/claude/sensitive-terms";
const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
const input = (session = "owned-session") => ({ prompt: "inspect compiler boundaries", session_id: session });
const context = (out: string | undefined): string => out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "recall-recovery-")); roots.push(directory);
  const deps: HookDeps = {
    recall: async () => [{ source: "fixture", content: "remember compiler boundaries" }],
    noteGate: { shouldNote: () => false, markNoted() {} },
    guard: createGuard({ phrases: ["secret-topic"], words: [] }), dedup: { directory },
  };
  return { directory, deps };
}
async function holder(directory: string, session = "owned-session", mark = "ready") {
  const ready = join(directory, mark);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/recall-holder.ts"), directory, session, ready], {
    env: { RECALL_GUARD_FIXTURE: "owned", HOME: directory, TMPDIR: directory, PATH: "/usr/bin:/bin" },
    stdout: "ignore", stderr: "pipe",
  }); children.push(child);
  const until = Date.now() + 5000;
  while (!existsSync(ready) && child.exitCode === null && Date.now() < until) await Bun.sleep(5);
  expect(existsSync(ready)).toBe(true);
  expect(child.exitCode).toBeNull();
  return child;
}
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("OL-1 regression: SIGKILL after decision entry recovers suppression on next and repeated hook", async () => {
  const { directory, deps } = fixture();
  expect(context(await runHook(input(), deps))).toContain("compiler boundaries");
  expect(context(await runHook(input(), deps))).toBe("");
  const before = readFileSync(join(directory, "owned-session.json"), "utf8");
  const child = await holder(directory); child.kill("SIGKILL"); expect(await child.exited).toBe(137);
  const legacy = await runHook(input(), { ...deps, dedup: undefined });
  const next = await runHook(input(), deps);
  expect(next).not.toBe(legacy);
  expect(context(next)).toBe("");
  expect(context(await runHook(input(), deps))).toBe("");
  expect(JSON.parse(readFileSync(join(directory, "owned-session.json"), "utf8")).hashes).toEqual(JSON.parse(before).hashes);
});
test("OL-2 a paused live holder beyond the decision deadline is never stolen", async () => {
  const { directory, deps } = fixture(); await runHook(input(), deps);
  const child = await holder(directory); process.kill(child.pid, "SIGSTOP");
  await Bun.sleep(2200);
  const legacy = await runHook(input(), { ...deps, dedup: undefined });
  expect(await runHook(input(), deps)).toBe(legacy);
  child.kill("SIGKILL"); expect(await child.exited).toBe(137);
  expect(context(await runHook(input(), deps))).toBe("");
}, 10000);
test("OL-2 successor stays exclusive after a previous killed holder", async () => {
  const { directory, deps } = fixture(); await runHook(input(), deps);
  const first = await holder(directory); first.kill("SIGKILL"); await first.exited;
  const second = await holder(directory, "owned-session", "successor");
  const legacy = await runHook(input(), { ...deps, dedup: undefined });
  expect(await runHook(input(), deps)).toBe(legacy);
  second.kill("SIGKILL"); await second.exited;
  expect(context(await runHook(input(), deps))).toBe("");
});
