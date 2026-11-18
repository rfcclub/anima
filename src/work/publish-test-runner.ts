/**
 * The test runner the host publish uses (rfcclub/anima#305, slice E5b-2): the derived `bun test` argv, run in the work
 * tree under the same write sandbox as the session's own tools, with a sanitized environment (no tokens, no `ANIMA_*`),
 * HOME and TMPDIR in a scratch directory that exists only for the run, and a 120 s timeout.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTests, type TestOutcome, type spawnRun } from "./publish-tests";
import { sandboxCommand, sanitizedEnv } from "./sandbox";

const TEST_TIMEOUT_MS = 120_000;

export function createHostTestRunner(options: {
  run: typeof spawnRun;
  denyReadRoots: string[];
  parentEnv: Record<string, string | undefined>;
}): (argv: string[], cwd: string) => Promise<TestOutcome> {
  return async (argv, cwd) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "anima-host-tests-")));
    try {
      const env = sanitizedEnv(options.parentEnv, { home: scratch, tmp: scratch });
      return await runTests(argv, {
        cwd,
        timeoutMs: TEST_TIMEOUT_MS,
        run: (command, directory, timeoutMs) => options.run(command, directory, timeoutMs, {
          env,
          wrap: (wrapped) => sandboxCommand({ writableRoots: [scratch], denyReadRoots: options.denyReadRoots }, wrapped),
        }),
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
}
