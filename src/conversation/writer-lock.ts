import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class SharedWriterLockError extends Error {
  constructor(readonly lockPath: string, readonly owner: string) {
    super(`shared conversation writer already owned: ${owner}`);
    this.name = "SharedWriterLockError";
  }
}

export interface SharedWriterOwner { pid: number; startedAt: string; }

export interface SharedWriterLock { release(): void; }

export interface SharedWriterLockOptions {
  /** Injected only for deterministic tests. Production uses `kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean;
}

/** One process may write a canonical session database. Existing locks are
 * are reclaimed only when their JSON owner has a demonstrably dead PID.
 * Unreadable, malformed, or live locks remain operator-recovery cases. */
export function acquireSharedWriterLock(
  dbPath: string,
  owner: SharedWriterOwner = { pid: process.pid, startedAt: new Date().toISOString() },
  options: SharedWriterLockOptions = {},
): SharedWriterLock {
  const lockPath = `${dbPath}.shared-writer.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    let existing = "unknown owner";
    try { existing = readFileSync(lockPath, "utf8").trim() || existing; } catch { /* keep ambiguity */ }
    if (!reclaimDeadLock(lockPath, existing, options.isProcessAlive ?? isProcessAlive)) {
      throw new SharedWriterLockError(lockPath, existing);
    }
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch {
      const current = (() => { try { return readFileSync(lockPath, "utf8").trim() || "unknown owner"; } catch { return "unknown owner"; } })();
      throw new SharedWriterLockError(lockPath, current);
    }
  }
  const marker = JSON.stringify(owner);
  writeFileSync(fd, marker, "utf8");
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      closeSync(fd);
      try {
        if (readFileSync(lockPath, "utf8") === marker) unlinkSync(lockPath);
      } catch { /* another process/operator changed it; never unlink blindly */ }
    },
  };
}

function reclaimDeadLock(lockPath: string, marker: string, isAlive: (pid: number) => boolean): boolean {
  let owner: SharedWriterOwner;
  try {
    owner = JSON.parse(marker) as SharedWriterOwner;
  } catch {
    return false;
  }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.startedAt !== "string" || isAlive(owner.pid)) return false;
  try {
    // Check the marker again immediately before unlinking so a release/reacquire
    // cannot be mistaken for the stale owner we inspected above.
    if (readFileSync(lockPath, "utf8") !== marker) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
