import { expect, test } from "bun:test";
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// Diagnostic only: no production import or source mutation. Capture native descriptor
// semantics on the actual CI host before selecting a portability fix.
test("OL-2 diagnostic: capture independent-descriptor close and failed-contender close", async () => {
  const root = mkdtempSync(join(tmpdir(), "recall-native-close-"));
  const childCode = `import {Database} from 'bun:sqlite'; let d; try { d=new Database(process.env.GUARD_PROBE_PATH,{create:false}); d.exec('PRAGMA busy_timeout=0'); d.exec('BEGIN IMMEDIATE'); console.log('acquired'); d.exec('ROLLBACK'); } catch { console.log('busy'); } finally { d?.close(); }`;
  const acquireElsewhere = async (path: string) => {
    const child = Bun.spawn([process.execPath, "-e", childCode], { env: { GUARD_PROBE_PATH: path, HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(0); expect(err).toBe(""); expect(["acquired", "busy"]).toContain(out.trim());
      return out.trim() === "acquired";
    } finally { clearTimeout(deadline); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
  };
  const rows: Record<string, boolean | string> = { platform: process.platform, bun: Bun.version };
  try {
    for (const variant of ["setup", "failedContender"] as const) {
      const path = join(root, variant + ".sqlite");
      let fd: number | undefined = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      let contenderFd: number | undefined;
      const db = new Database(path, { create: false }); let contender: Database | undefined;
      try {
        db.exec("PRAGMA busy_timeout=0"); db.exec("BEGIN IMMEDIATE");
        rows[variant + "BeforeClose"] = await acquireElsewhere(path);
        expect(rows[variant + "BeforeClose"]).toBe(false);
        if (variant === "setup") { closeSync(fd); fd = undefined; }
        else {
          contenderFd = openSync(path, constants.O_RDWR);
          contender = new Database(path, { create: false }); contender.exec("PRAGMA busy_timeout=0");
          let refused = false; try { contender.exec("BEGIN IMMEDIATE"); } catch { refused = true; }
          rows.contenderRefused = refused; expect(refused).toBe(true);
          contender.close(); contender = undefined;
          closeSync(contenderFd); contenderFd = undefined;
        }
        rows[variant + "AfterClose"] = await acquireElsewhere(path);
      } finally {
        try { db.exec("ROLLBACK"); } finally { db.close(); }
        contender?.close(); if (contenderFd !== undefined) closeSync(contenderFd); if (fd !== undefined) closeSync(fd);
      }
      rows[variant + "AfterRelease"] = await acquireElsewhere(path);
      expect(rows[variant + "AfterRelease"]).toBe(true);
    }
    console.log("OL-2_NATIVE_CLOSE_PROBE " + JSON.stringify(rows));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20000);
