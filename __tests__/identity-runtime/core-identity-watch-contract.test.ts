import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skipNativeWatchIntegration } from "../../src/identity-runtime/fixtures/native-watch-policy";

test("watch regression: quarantine applies only to the observed host tuple and opt-in overrides it", () => {
  const cases = [
    { platform: "darwin", bunVersion: "1.3.14", optIn: undefined },
    { platform: "darwin", bunVersion: "1.3.14", optIn: "0" },
    { platform: "darwin", bunVersion: "1.3.14", optIn: "1" },
    { platform: "linux", bunVersion: "1.3.14", optIn: undefined },
    { platform: "linux", bunVersion: "1.4.4", optIn: undefined },
    { platform: "darwin", bunVersion: "1.3.15", optIn: undefined },
    { platform: "darwin", bunVersion: "1.4.4", optIn: undefined },
    { platform: "darwin", bunVersion: "1.4.4", optIn: "0" },
    { platform: "darwin", bunVersion: "1.4.4", optIn: "true" },
    { platform: "darwin", bunVersion: "1.4.4", optIn: "1" },
    { platform: "win32", bunVersion: "1.4.4", optIn: undefined },
    { platform: "darwin", bunVersion: "1.4.5", optIn: undefined },
    { platform: "win32", bunVersion: "1.3.14", optIn: undefined },
    { platform: "darwin", bunVersion: "1.3.14", optIn: "true" },
    { platform: "linux", bunVersion: "1.3.14", optIn: "0" },
  ];
  expect(cases.map(skipNativeWatchIntegration)).toEqual([true, true, false, false, false, false, true, true, true, false, false, false, false, true, false]);
});

async function fixture(scenario: string, invalid?: "root" | "env") {
  const root = mkdtempSync(join(tmpdir(), "anima-watch-contract-"));
  try {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/core-identity-watch-contract.ts"), scenario, root], {
      env: {
        PATH: process.env.PATH ?? "", HOME: invalid === "root" ? `${root}/wrong` : root, ANIMA_HOME: root,
        NODE_ENV: "test", ...(invalid === "env" ? { WATCH_PARENT_CANARY: "forbidden" } : {}),
      },
      stdout: "pipe", stderr: "pipe",
    });
    const deadline = setTimeout(() => proc.kill(), 5000);
    let exit: number, stdout: string, stderr: string;
    try { [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]); }
    finally { clearTimeout(deadline); }
    if (invalid) {
      expect(exit).not.toBe(0); expect(stdout).toBe("");
      expect(stderr).toContain(invalid === "root" ? "unsafe fixture root" : "unsafe fixture environment");
      return;
    }
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const receipt = JSON.parse(stdout);
    const expectedPaths = ["SOUL.md", "codex-one/KERNEL.md", "codex-one/JUDGMENTS.md", "codex-one/OWNER.md", "codex-one/SCARS.md"].map((path) => join(root, path));
    expect(receipt.subscriptions.map((entry: { path: string }) => entry.path)).toEqual(scenario === "independent" ? [...expectedPaths, ...expectedPaths] : expectedPaths);
    expect(receipt.subscriptions.map((entry: { closes: number }) => entry.closes)).toEqual(Array(scenario === "independent" ? 10 : 5).fill(1));
    expect(receipt.pending).toBe(0);
    for (const call of receipt.calls) expect(call.paths).toEqual({ agoraRoot: root, cacheDir: join(root, "cache") });
    return receipt;
  } finally {
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  }
}

test("watch regression: five source subscriptions forward the same compile paths and exclude the cache", async () => {
  const receipt = await fixture("subscriptions");
  expect(receipt.calls.map((call: { at: number }) => call.at)).toEqual([20, 40, 60, 80, 100]);
});
test("watch regression: a burst compiles once after the debounce deadline", async () => {
  const receipt = await fixture("burst");
  expect(receipt.samples).toEqual([0, 1]); expect(receipt.calls).toHaveLength(1);
});
test("watch regression: a later event resets the pending deadline", async () => {
  const receipt = await fixture("reset");
  expect(receipt.samples).toEqual([0, 0, 1]); expect(receipt.calls.map((call: { at: number }) => call.at)).toEqual([39]);
});
test("watch regression: close cancels a pending compile and closes every subscription", async () => {
  const receipt = await fixture("cancel");
  expect(receipt.calls).toEqual([]);
});
test("watch regression: closing one handle leaves another handle working", async () => {
  const receipt = await fixture("independent");
  expect(receipt.calls.map((call: { owner: string }) => call.owner)).toEqual(["second"]);
});
test("watch regression: default debounce remains one second", async () => {
  const receipt = await fixture("default-delay");
  expect(receipt.samples).toEqual([0, 1]); expect(receipt.calls.map((call: { at: number }) => call.at)).toEqual([1000]);
});
test("watch child refuses a mismatched HOME before importing the watcher", async () => { await fixture("burst", "root"); });
test("watch child refuses a forbidden inherited environment before importing the watcher", async () => { await fixture("burst", "env"); });
test("watch child environment excludes a parent canary and preserves parent HOME", async () => {
  const previous = process.env.WATCH_PARENT_CANARY, home = process.env.HOME;
  process.env.WATCH_PARENT_CANARY = "parent-only";
  try {
    const receipt = await fixture("burst");
    expect(receipt.calls).toHaveLength(1);
    expect(process.env.HOME).toBe(home);
  } finally {
    if (previous === undefined) delete process.env.WATCH_PARENT_CANARY;
    else process.env.WATCH_PARENT_CANARY = previous;
  }
});
