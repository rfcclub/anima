import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("beam negative cases restore the test runner's exit status", async () => {
  const root = mkdtempSync(join(tmpdir(), "anima-beam-isolation-"));
  try {
    for (const initialStatus of [undefined, 17]) {
      const preload = join(root, "status.ts");
      if (initialStatus !== undefined) writeFileSync(preload, `process.exitCode = ${initialStatus};\n`);
      const child = Bun.spawn([process.execPath, "test", ...(initialStatus === undefined ? [] : ["--preload", preload]), "./src/cli-beam.test.ts"], {
        cwd: join(import.meta.dir, "../.."),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          TMPDIR: root,
          ANIMA_HOME: root,
          ANIMA_COST_DB: ":memory:",
          NODE_ENV: "test",
          NO_COLOR: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill(), 10000);
      let rawExit: number, stdout: string, stderr: string;
      try {
        [rawExit, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
      } finally {
        clearTimeout(timer);
      }
      expect(stdout + stderr).toContain("5 pass");
      expect(stdout + stderr).toContain("0 fail");
      expect(rawExit).toBe(initialStatus ?? 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  }
}, 15000);
