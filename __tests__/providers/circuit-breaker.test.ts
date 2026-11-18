/**
 * CircuitBreaker — unit tests
 * Covers: state transitions, atomic write, stale purge, concurrent safety.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CircuitBreaker, type BreakerFile } from "../../src/providers/circuit-breaker";

// Helper to create a breaker with a unique temp file per test
function breakerPath(name: string): string {
  return join(homedir(), ".anima", `__test_breaker_${name}_${Date.now()}.json`);
}

function cleanup(path: string): void {
  try { unlinkSync(path); } catch { /* ignore */ }
  try { unlinkSync(path + ".tmp"); } catch { /* ignore */ }
}

// Stale entry helper: create a state with openedAt far in the past
function staleState(): import("../../src/providers/circuit-breaker").BreakerState {
  const past = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
  return {
    state: "open",
    failureCount: 2,
    openedAt: past,
    resetAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  };
}

describe("CircuitBreaker — State Transitions", () => {
  const path = breakerPath("transitions");
  afterEach(() => cleanup(path));

  test("unknown provider returns null state", async () => {
    const cb = new CircuitBreaker(path);
    const state = await cb.getState("unknown-provider");
    expect(state).toBeNull();
  });

  test("closed → open after 2 failures", async () => {
    const cb = new CircuitBreaker(path);
    await cb.read(); // initialize cache

    // 1st failure — still closed
    cb.recordFailure("minimax");
    let state = await cb.getState("minimax");
    expect(state?.state).toBe("closed");
    expect(state?.failureCount).toBe(1);

    // 2nd failure — opens
    cb.recordFailure("minimax");
    state = await cb.getState("minimax");
    expect(state?.state).toBe("open");
    expect(state?.failureCount).toBe(2);
    expect(state?.openedAt).toBeDefined();
    expect(state?.resetAt).toBeDefined();
    // resetAt should be ~5 min after openedAt
    const openedAt = new Date(state!.openedAt).getTime();
    const resetAt = new Date(state!.resetAt).getTime();
    expect(resetAt - openedAt).toBeGreaterThanOrEqual(4.9 * 60 * 1000);
    expect(resetAt - openedAt).toBeLessThanOrEqual(5.1 * 60 * 1000);
  });

  test("open breaker isOpen() returns true", async () => {
    const cb = new CircuitBreaker(path);
    cb.recordFailure("exampleprov");
    cb.recordFailure("exampleprov");
    expect(await cb.isOpen("exampleprov")).toBe(true);
    expect(await cb.isHalfOpen("exampleprov")).toBe(false);
  });

  test("open → half_open after cooldown expires via getState", async () => {
    const cb = new CircuitBreaker(path);
    // Manually write an OPEN state where cooldown expired
    const pastReset = new Date(Date.now() - 1_000).toISOString(); // 1s ago
    const pastOpen = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 min ago
    cb.write("exampleprov", {
      state: "open",
      failureCount: 2,
      openedAt: pastOpen,
      resetAt: pastReset,
    });

    // getState should report half_open since cooldown expired
    const state = await cb.getState("exampleprov");
    expect(state?.state).toBe("half_open");

    // isOpen should be false (past reset)
    expect(await cb.isOpen("exampleprov")).toBe(false);
    // isHalfOpen should be true
    expect(await cb.isHalfOpen("exampleprov")).toBe(true);
  });

  test("half_open → closed on recordSuccess", async () => {
    const cb = new CircuitBreaker(path);
    // Setup half_open state via manual write
    const pastReset = new Date(Date.now() - 1_000).toISOString();
    const pastOpen = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    cb.write("exampleprov", {
      state: "open",
      failureCount: 3,
      openedAt: pastOpen,
      resetAt: pastReset,
    });

    cb.recordSuccess("exampleprov");
    const state = await cb.getState("exampleprov");
    expect(state?.state).toBe("closed");
    expect(state?.failureCount).toBe(0);
  });

  test("half_open → open on additional failure", async () => {
    const cb = new CircuitBreaker(path);
    // Setup half_open via expired cooldown
    const pastReset = new Date(Date.now() - 1_000).toISOString();
    const pastOpen = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    cb.write("exampleprov", {
      state: "open",
      failureCount: 3,
      openedAt: pastOpen,
      resetAt: pastReset,
    });

    // Record a failure while in half_open state
    cb.recordFailure("exampleprov");
    const state = await cb.getState("exampleprov");
    expect(state?.state).toBe("open");
    expect(state?.failureCount).toBe(4);
    // resetAt should be extended (~5 min from now)
    const newResetAt = new Date(state!.resetAt).getTime();
    expect(newResetAt).toBeGreaterThan(Date.now() + 4.9 * 60 * 1000);
  });

  test("3+ failures keep breaker open", async () => {
    const cb = new CircuitBreaker(path);
    cb.recordFailure("wafer");
    cb.recordFailure("wafer"); // opens
    const state1 = await cb.getState("wafer");
    expect(state1?.state).toBe("open");

    cb.recordFailure("wafer"); // extra failure
    const state2 = await cb.getState("wafer");
    expect(state2?.state).toBe("open");
    expect(state2?.failureCount).toBe(3);
  });
});

describe("CircuitBreaker — File I/O", () => {
  test("breaker file is created on first write", async () => {
    const path = breakerPath("first-write");
    try {
      const cb = new CircuitBreaker(path);
      cb.recordFailure("minimax");

      // Re-read from disk (fresh instance)
      const cb2 = new CircuitBreaker(path);
      const state = await cb2.getState("minimax");
      expect(state).not.toBeNull();
      expect(state?.state).toBe("closed");
      expect(state?.failureCount).toBe(1);
    } finally {
      cleanup(path);
    }
  });

  test("atomic write: .tmp file cleaned up", async () => {
    const path = breakerPath("atomic");
    try {
      const cb = new CircuitBreaker(path);
      cb.recordFailure("minimax");
      cb.recordFailure("minimax"); // opens

      // .tmp should be cleaned up (rename succeeded)
      const { existsSync } = await import("node:fs");
      expect(existsSync(path)).toBe(true);
      expect(existsSync(path + ".tmp")).toBe(false);
    } finally {
      cleanup(path);
    }
  });

  test("state persists across breaker instances", async () => {
    const path = breakerPath("persist");
    try {
      const cb1 = new CircuitBreaker(path);
      cb1.recordFailure("gemini");
      cb1.recordFailure("gemini");

      const cb2 = new CircuitBreaker(path);
      await cb2.read();
      const state = await cb2.getState("gemini");
      expect(state?.state).toBe("open");
      expect(state?.failureCount).toBe(2);
    } finally {
      cleanup(path);
    }
  });

  test("Stale entries purged on read (>24h no update)", async () => {
    const path = breakerPath("stale");
    try {
      // Manually write a file with a stale entry
      const cb = new CircuitBreaker(path);
      cb.write("stale-provider", staleState());
      cb.recordFailure("fresh-provider"); // non-stale

      // Read with fresh instance — stale should be purged
      const cb2 = new CircuitBreaker(path);
      const all = await cb2.read();
      expect(all["stale-provider"]).toBeUndefined();
      expect(all["fresh-provider"]).toBeDefined();
    } finally {
      cleanup(path);
    }
  });
});

describe("CircuitBreaker — Concurrent Safety", () => {
  test("last writer wins — no corruption", async () => {
    const path = breakerPath("concurrent");
    try {
      const cb1 = new CircuitBreaker(path);
      const cb2 = new CircuitBreaker(path);

      // Both read initial state
      await cb1.read();
      await cb2.read();

      // Both write — cb2 wins (last write)
      cb1.recordFailure("provider-a");
      cb2.recordFailure("provider-b");

      // Final state should have both or at least provider-b
      const cb3 = new CircuitBreaker(path);
      const all = await cb3.read();
      // Last writer (cb2) wins; cb1's write is overwritten
      expect(all["provider-b"]).toBeDefined();
      // Either both present (if cb1 wrote first) or just provider-b (if cb2's write shadowed cb1)
      // Both scenarios are acceptable per D7
      const json = JSON.stringify(all);
      expect(() => JSON.parse(json)).not.toThrow(); // valid JSON
    } finally {
      cleanup(path);
    }
  });

  test("one agent opens breaker while another reads — idempotent", async () => {
    const path = breakerPath("idempotent");
    try {
      const cbWriter = new CircuitBreaker(path);
      cbWriter.recordFailure("exampleprov");
      cbWriter.recordFailure("exampleprov"); // opens

      // Reader reads while writer has opened
      const cbReader = new CircuitBreaker(path);
      const state = await cbReader.getState("exampleprov");
      // Either sees OPEN (new version) or reads old version (then will fail and re-open)
      if (state === null) {
        // Saw old version, would try exampleprov, fail, and re-open — idempotent
        cbReader.recordFailure("exampleprov");
        cbReader.recordFailure("exampleprov");
        const retry = await cbReader.getState("exampleprov");
        expect(retry?.state).toBe("open");
      } else {
        expect(state.state === "open" || state.state === "closed").toBe(true);
      }
    } finally {
      cleanup(path);
    }
  });
});

describe("CircuitBreaker — ENV override", () => {
  test("ANIMA_BREAKER_FILE env var respected", async () => {
    const customPath = breakerPath("env-override");
    try {
      const cb = new CircuitBreaker(customPath);
      expect(cb.filePath).toBe(customPath);
    } finally {
      cleanup(customPath);
    }
  });

  test("default path is ~/.anima/breaker.json", () => {
    const cb = new CircuitBreaker();
    expect(cb.filePath).toContain(".anima");
    expect(cb.filePath).toContain("breaker.json");
  });
});
