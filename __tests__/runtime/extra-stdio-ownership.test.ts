import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
async function fixture(invalid?: "root" | "env") {
  const root = mkdtempSync(join(tmpdir(), "anima-extra-stdio-"));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/extra-stdio-ownership.ts"), root], {
      env: { PATH: process.env.PATH ?? "", HOME: invalid === "root" ? `${root}/wrong` : root, ANIMA_HOME: root, NODE_ENV: "test", ...(invalid === "env" ? { RUNTIME_PARENT_CANARY: "forbidden" } : {}) },
      stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 5000);
    let rawExit: number, stdout: string, stderr: string;
    try { [rawExit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); }
    finally { clearTimeout(timer); }
    if (invalid) {
      expect(rawExit).not.toBe(0); expect(stdout).toBe("");
      expect(stderr).toContain(invalid === "root" ? "unsafe fixture root" : "unsafe fixture environment");
      return;
    }
    expect({ rawExit, stderr }).toEqual({ rawExit: 0, stderr: "" });
    const receipt = JSON.parse(stdout);
    expect(receipt.hits).toBe(0); expect(receipt.rows).toHaveLength(4);
    for (const row of receipt.rows) { expect(row.victim).toBe(row.fd); expect(row.error).toBeNull(); }
    return receipt;
  } finally { rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false); }
}
// POSIX raw-fd transfer is the upstream contract; Windows uses different handles.
test.skipIf(process.platform === "win32")("runtime regression: extra stdio finalization preserves four recycled victim descriptors", async () => { await fixture(); });
test("runtime child refuses a mismatched HOME", async () => { await fixture("root"); });
test("runtime child refuses a forbidden inherited credential environment", async () => { await fixture("env"); });
test.skipIf(process.platform === "win32")("runtime child excludes a parent canary and preserves parent HOME", async () => {
  const previous = process.env.RUNTIME_PARENT_CANARY, home = process.env.HOME;
  process.env.RUNTIME_PARENT_CANARY = "parent-only";
  try { await fixture(); expect(process.env.HOME).toBe(home); }
  finally { if (previous === undefined) delete process.env.RUNTIME_PARENT_CANARY; else process.env.RUNTIME_PARENT_CANARY = previous; }
});
