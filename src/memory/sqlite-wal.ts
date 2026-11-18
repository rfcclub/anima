import type { Database } from "bun:sqlite";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/**
 * Configure a newly opened database. SQLite may return SQLITE_BUSY from
 * journal_mode without invoking its busy handler, so retry that pragma
 * asynchronously and set the regular per-connection timeout afterwards.
 */
export async function configureMemoryWal(db: Database): Promise<void> {
  db.exec("PRAGMA busy_timeout=0");
  const deadline = performance.now() + SQLITE_BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode=WAL");
      break;
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const remaining = deadline - performance.now();
      if (typeof code !== "string" || !/^SQLITE_BUSY(?:_|$)/.test(code) || remaining <= 0) throw error;
      await Bun.sleep(Math.min(25, remaining));
    }
  }
  db.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
}
