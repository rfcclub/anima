import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "..", "scripts", "hindsight-wrapup.ts");

describe("hindsight-wrapup CLI stdin", () => {
  test("stdin held open and empty does not leave the CLI waiting forever", async () => {
    const home = mkdtempSync(join(tmpdir(), "wrapup-home-"));
    const started = Date.now();
    // stdin opened as a pipe and never written to or closed: an agent that starts the CLI and
    // stops must not be able to hold it open past its own deadline.
    const child = Bun.spawn(["bun", script, "--bank", "b", "--session", "s", "--stdin-timeout-ms", "150"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home },
    });
    let killed = false;
    const guard = setTimeout(() => {
      killed = true;
      child.kill();
    }, 4_000);
    const exitCode = await child.exited;
    clearTimeout(guard);
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    child.stdin.flush();
    expect(killed).toBe(false);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(exitCode).toBe(1);
    expect(`${stdout}\n${stderr}`).toContain("stdin-timeout");
  });
});
