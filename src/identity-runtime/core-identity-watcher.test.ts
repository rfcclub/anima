import { describe, test, expect, mock } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCoreIdentityWatcher } from "./core-identity-watcher";
import { skipNativeWatchIntegration } from "./fixtures/native-watch-policy";

// Real OS-level fs.watch() delivery timing is not instantaneous, and gets
// noisier when this file runs alongside other test files sharing one bun
// test process (confirmed via bisection: sqlite-backed suites elsewhere in
// this directory measurably delay fs.watch event delivery here even though
// they never touch the watched paths). Poll for the expected call count
// instead of asserting once after a fixed sleep.
async function waitFor(check: () => boolean, timeoutMs: number, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Native integration is opt-in only on the observed macOS/Bun 1.3.14 and 1.4.4 tuples.
// Always-run callback/debounce/close contracts live in __tests__/identity-runtime/.
describe.skipIf(skipNativeWatchIntegration({ platform: process.platform, bunVersion: Bun.version, optIn: process.env.ANIMA_TEST_OS_WATCH }))("startCoreIdentityWatcher", () => {
  test("SC-019/020: a burst of changes across watched files triggers exactly one rebuild", async () => {
    const dir = await mkdtemp(join(tmpdir(), "core-identity-watch-"));
    await mkdir(join(dir, "codex-one"), { recursive: true });
    await mkdir(join(dir, "identityCache"), { recursive: true });
    for (const f of ["SOUL.md", "codex-one/KERNEL.md", "codex-one/JUDGMENTS.md", "codex-one/OWNER.md", "codex-one/SCARS.md"]) {
      await writeFile(join(dir, f), "seed", "utf-8");
    }

    const onRebuild = mock(() => Promise.resolve());
    // debounceMs must clear real fs.watch delivery jitter between the two
    // writes below, not just be "long enough in the common case" — 30ms was
    // tight enough that delivery jitter under a busy test process could
    // land the two write events on either side of the window, producing 2
    // separate debounced calls instead of 1 (both writes are still well
    // within this margin of each other).
    const watcher = startCoreIdentityWatcher(
      { agoraRoot: dir, cacheDir: join(dir, "identityCache") },
      { debounceMs: 150, compile: onRebuild },
    );

    try {
      await writeFile(join(dir, "SOUL.md"), "changed 1", "utf-8");
      await writeFile(join(dir, "codex-one/OWNER.md"), "changed 2", "utf-8");

      await waitFor(() => onRebuild.mock.calls.length >= 1, 2000);
      // extra settle window: a broken debounce would fire a second call here
      await new Promise((r) => setTimeout(r, 250));

      expect(onRebuild.mock.calls.length).toBe(1);
    } finally {
      watcher.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("SC-021: a change inside cacheDir never triggers a rebuild", async () => {
    const dir = await mkdtemp(join(tmpdir(), "core-identity-watch-"));
    await mkdir(join(dir, "codex-one"), { recursive: true });
    await mkdir(join(dir, "identityCache"), { recursive: true });
    for (const f of ["SOUL.md", "codex-one/KERNEL.md", "codex-one/JUDGMENTS.md", "codex-one/OWNER.md", "codex-one/SCARS.md"]) {
      await writeFile(join(dir, f), "seed", "utf-8");
    }

    const onRebuild = mock(() => Promise.resolve());
    const watcher = startCoreIdentityWatcher(
      { agoraRoot: dir, cacheDir: join(dir, "identityCache") },
      { debounceMs: 30, compile: onRebuild },
    );

    try {
      // macOS delivers filesystem events late: the seed writes above can surface
      // AFTER the watcher exists and would be counted as a rebuild this test is
      // not about (it failed ~2 runs in 4; a fixed sleep still left ~1 in 14, since
      // the delay varies with load). Wait until the call count has been quiet for
      // a full interval, then measure only what the cache write adds.
      let quietFor = 0;
      let lastCount = -1;
      for (let waited = 0; quietFor < 200 && waited < 3000; waited += 50) {
        await new Promise((r) => setTimeout(r, 50));
        const count = onRebuild.mock.calls.length;
        quietFor = count === lastCount ? quietFor + 50 : 0;
        lastCount = count;
      }
      const baseline = onRebuild.mock.calls.length;

      await writeFile(join(dir, "identityCache/CORE_IDENTITY.md"), "compiler output", "utf-8");
      await new Promise((r) => setTimeout(r, 250));

      expect(onRebuild.mock.calls.length).toBe(baseline);
    } finally {
      watcher.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
