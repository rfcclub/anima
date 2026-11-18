/**
 * CircuitBreaker — shared provider health state.
 *
 * Three-state machine: CLOSED → OPEN → HALF_OPEN → CLOSED (or back to OPEN).
 * State is persisted to a JSON file (~/.anima/breaker.json) with atomic writes
 * so that all ANIMA and OpenClaw agents can read/write concurrently.
 *
 * - CLOSED: normal operation, requests pass through
 * - OPEN: breaker tripped (≥2 failures), all agents skip this provider
 * - HALF_OPEN: cooldown expired, next agent gets 1 trial request
 *
 * Cooldown: 5 minutes. Stale entries (>24h no updates) are purged on read.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

// --- Types (tasks 1.2, 1.3) ---

export type BreakerStateName = "closed" | "open" | "half_open";

export interface BreakerState {
  state: BreakerStateName;
  failureCount: number;
  /** UTC ISO timestamp when the breaker opened. */
  openedAt: string;
  /** UTC ISO timestamp when the breaker resets to half-open. */
  resetAt: string;
}

export type BreakerFile = Record<string, BreakerState>;

// --- Constants ---

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes (D8)
const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours (D9)
const FAILURE_THRESHOLD = 2; // ≥2 failures → OPEN (D2)

/** Observed 2026-09-12: a 2-failure threshold plus a reasoning model that can
 *  legitimately run past the old 60s speech timeout tripped the breaker on
 *  otherwise-healthy providers (openference: confirmed healthy via a direct
 *  curl test the same day) and then blocked every subsequent request,
 *  including simple ones, for the full 5-minute cooldown. Temporary escape
 *  hatch — set ANIMA_BREAKER_DISABLED=true to bypass the breaker entirely
 *  without ripping out the mechanism. Unset (or "false") restores normal
 *  behavior with no code change. */
function breakerDisabled(): boolean {
  return (process.env.ANIMA_BREAKER_DISABLED ?? Bun.env.ANIMA_BREAKER_DISABLED) === "true";
}

// --- Helpers ---

function resolveBreakerPath(): string {
  return (
    process.env.ANIMA_BREAKER_FILE ??
    Bun.env.ANIMA_BREAKER_FILE ??
    join(homedir(), ".anima", "breaker.json")
  );
}

function ensureDir(filePath: string): void {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function nowISO(): string {
  return new Date().toISOString();
}

/** Check if a breaker entry is stale (>24h since last update). */
function isStale(entry: BreakerState): boolean {
  // openedAt is the most reliable "last activity" timestamp
  const lastActivity = new Date(entry.openedAt).getTime();
  return Date.now() - lastActivity > STALE_MS;
}

// --- CircuitBreaker ---

export class CircuitBreaker {
  readonly filePath: string;
  // In-memory cache to avoid repeated disk reads within a single request.
  // Cleared on write, populated on read.
  private _cache: BreakerFile | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? resolveBreakerPath();
  }

  // --- Read/Write (tasks 1.4, 1.5) ---

  /** Read breaker file, purge stale entries, return state. */
  async read(): Promise<BreakerFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: BreakerFile = JSON.parse(raw);
      let purged = false;

      for (const [providerId, state] of Object.entries(parsed)) {
        if (isStale(state)) {
          delete parsed[providerId];
          purged = true;
        }
      }

      if (purged) {
        // Write back purged version (best-effort, don't block on failure)
        try {
          this.writeFileSync(parsed);
        } catch {
          // If we can't write, still return the in-memory purged version
        }
      }

      this._cache = parsed;
      return parsed;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this._cache = {};
        return {};
      }
      throw new Error(
        `failed to read breaker file ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Write updated state for a single provider using atomic rename. */
  write(providerId: string, state: BreakerState): void {
    const all = this._cache ?? {};
    all[providerId] = state;
    this.writeFileSync(all);
    this._cache = all;
  }

  /** Atomic write: temp file → rename. */
  private writeFileSync(data: BreakerFile): void {
    ensureDir(this.filePath);
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.filePath);
    // Clean up stale tmp file if rename left it (shouldn't happen on POSIX)
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }

  // --- State queries (tasks 1.6, 1.7, 1.8) ---

  /** Get current breaker state for a provider, handling half-open transition. */
  async getState(providerId: string): Promise<BreakerState | null> {
    const all = await this.read();
    const entry = all[providerId];
    if (!entry) return null;

    // half-open transition: OPEN but past resetAt → treat as HALF_OPEN
    if (entry.state === "open" && Date.now() >= new Date(entry.resetAt).getTime()) {
      // Don't mutate on read — caller decides whether to trial
      return { ...entry, state: "half_open" };
    }

    return entry;
  }

  /** Returns true if provider is OPEN and not past resetAt (should be skipped). */
  async isOpen(providerId: string): Promise<boolean> {
    if (breakerDisabled()) return false;
    const state = await this.getState(providerId);
    if (!state) return false;
    return state.state === "open";
  }

  /** Returns true if provider is past cooldown but not yet trialed (half_open). */
  async isHalfOpen(providerId: string): Promise<boolean> {
    if (breakerDisabled()) return false;
    const state = await this.getState(providerId);
    if (!state) return false;
    return state.state === "half_open";
  }

  // --- State mutations (tasks 1.9, 1.10) ---

  /** Increment failure count; open breaker if ≥2 failures. */
  recordFailure(providerId: string): void {
    if (breakerDisabled()) return;
    const all = this._cache ?? {};
    const entry = all[providerId];

    const failureCount = (entry?.failureCount ?? 0) + 1;
    const now = nowISO();
    const resetAt = new Date(Date.now() + COOLDOWN_MS).toISOString();

    if (failureCount >= FAILURE_THRESHOLD) {
      this.write(providerId, {
        state: "open",
        failureCount,
        openedAt: now,
        resetAt,
      });
    } else {
      this.write(providerId, {
        state: entry?.state ?? "closed",
        failureCount,
        openedAt: entry?.openedAt ?? now,
        resetAt: entry?.resetAt ?? resetAt,
      });
    }
  }

  /** After a model answered on this provider, clear a non-zero failure count
   *  (PR #101: a same-provider fallback must not trip the shared breaker).
   *  Follows the disabled policy, and a breaker-file error never fails the
   *  successful request. */
  async recordModelSuccess(providerId: string): Promise<void> {
    if (breakerDisabled()) return;
    try {
      const state = await this.getState(providerId);
      if ((state?.failureCount ?? 0) > 0) this.recordSuccess(providerId);
    } catch {
      // The request already succeeded; breaker bookkeeping is best-effort here.
    }
  }

  /** Transition to CLOSED, reset failure count. Only called on half-open success. */
  recordSuccess(providerId: string): void {
    this.write(providerId, {
      state: "closed",
      failureCount: 0,
      openedAt: nowISO(),
      resetAt: nowISO(),
    });
  }
}
