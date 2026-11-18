// Fail closed: a sandboxed browser launch must succeed before CI full tests.
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const root = mkdtempSync(join(tmpdir(), "anima-chromium-probe-"));
try {
  const context = await chromium.launchPersistentContext(root, { headless: true, chromiumSandbox: true, timeout: 5000 });
  await context.close();
  console.log(JSON.stringify({ uid: process.getuid(), sandbox: true, launched: true }));
} catch (error) {
  console.log(JSON.stringify({ uid: process.getuid(), sandbox: true, launched: false, error: String(error) }));
  for (const [command, args] of [
    ["sysctl", ["kernel.apparmor_restrict_unprivileged_userns", "kernel.unprivileged_userns_clone", "user.max_user_namespaces"]],
    ["unshare", ["--user", "--map-root-user", "true"]],
  ]) {
    const r = spawnSync(command, args, { encoding: "utf8" });
    console.log(JSON.stringify({ command, args, raw_exit: r.status, stdout: r.stdout, stderr: r.stderr }));
  }
  process.exitCode = 1;
} finally { rmSync(root, { recursive: true, force: true }); }