import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { TokenLedger } from "./ledger";

/** Where the process ledger lives. A test run (NODE_ENV=test, which bun test sets) gets an
 *  in-memory ledger unless ANIMA_COST_DB names a file, so tests never write to the live DB. */
export function resolveCostDbPath(env: Record<string, string | undefined>): string {
  if (env.ANIMA_COST_DB) return env.ANIMA_COST_DB;
  if (env.NODE_ENV === "test") return ":memory:";
  return join(env.HOME ?? homedir(), ".anima", "cost.db");
}

const DB_PATH = resolveCostDbPath(process.env);

let _ledger: TokenLedger | null = null;

/** The process ledger on ANIMA_COST_DB (default ~/.anima/cost.db), opened on first use. */
/** Opens the cost database. A writer that finds it busy waits up to 100 ms instead of failing at
 *  once (the server and short-lived CLI runs write to the same file); past that the call record is
 *  dropped with a diagnostic, never the provider's result. */
export function openCostDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA busy_timeout = 100");
  return db;
}

export function getDefaultLedger(): TokenLedger {
  if (!_ledger) {
    _ledger = new TokenLedger(openCostDb(DB_PATH));
  }
  return _ledger;
}

/** Replaces the process ledger (tests). null makes the next use open the default one again. */
export function setDefaultLedger(ledger: TokenLedger | null): void {
  _ledger = ledger;
}

function getLedger(): TokenLedger {
  return getDefaultLedger();
}

export interface LogUsageInput {
  sessionId: string;
  agentId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function logTokenUsage(input: LogUsageInput): void {
  try {
    getLedger().log(input);
  } catch {
    // Cost logging is non-critical — never fail a request for it
  }
}
