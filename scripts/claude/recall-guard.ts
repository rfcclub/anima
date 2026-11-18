import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export const RECALL_GUARD_SHARDS = 64;
export function recallGuardPath(directory: string, sessionId: string): string {
  const shard = createHash("sha256").update(sessionId).digest().readUInt32BE(0) % RECALL_GUARD_SHARDS;
  return join(directory, `.recall-guard-${shard.toString(16).padStart(2, "0")}.sqlite`);
}

/**
 * Private empty database used only for kernel-owned exclusion. Never unlink a guard.
 * SQLite alone opens existing guards: a manual close of the same inode in this
 * process can release its Linux POSIX locks. Do not read guard/journal bytes or
 * add a diagnostic descriptor while a local holder lives; use path-only stat.
 */
export function acquireRecallGuard(directory: string, sessionId: string): (() => void) | undefined {
  let db: Database | undefined, begun = false;
  const close = () => {
    if (begun) { begun = false; try { db?.exec("ROLLBACK"); } catch {} }
    try { db?.close(); } catch {} db = undefined;
  };
  try {
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || !(dir.mode & 0o200)) return undefined;
    const path = recallGuardPath(directory, sessionId);
    // Exclusive creation closes only a new inode before this process locks it.
    // EEXIST must never open/close an unmanaged descriptor for a live guard.
    try { closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size !== 0 || stat.nlink !== 1 || !(stat.mode & 0o200) || stat.isSymbolicLink()) return undefined;
    chmodSync(path, 0o600);
    db = new Database(path, { create: false, strict: true });
    db.exec("PRAGMA busy_timeout=0");
    if ((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode !== "delete") throw Error("guard mode");
    db.exec("BEGIN IMMEDIATE"); begun = true;
    const current = lstatSync(path);
    if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) throw Error("guard changed");
    let released = false;
    return () => { if (!released) { released = true; close(); } };
  } catch { close(); return undefined; }
}
