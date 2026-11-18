/**
 * castle-work-loop, WL-9: finite persistent execution caps.
 * Pure config tests; no database file is touched.
 */

import { test, expect, describe } from "bun:test";
import { loadWorkConfig, parseStoredCaps, DEFAULT_CAPS } from "../../src/work/config";

describe("loadWorkConfig", () => {
  test("materialises the pinned author, provider, model and the default caps", () => {
    const c = loadWorkConfig({});
    expect(c.author).toBe("finn");
    expect(c.provider).toBe("agnes");
    expect(c.model).toBe("agnes-3.0-flash");
    expect(c.caps).toEqual({ maxSessions: 3, maxIterationsPerSession: 5, sessionWallMs: 10 * 60_000, workWallMs: 30 * 60_000 });
    expect(c.caps).toEqual(DEFAULT_CAPS);
  });

  test("keeps explicit valid overrides and leaves the other defaults", () => {
    const c = loadWorkConfig({ caps: { maxSessions: 2 } });
    expect(c.caps.maxSessions).toBe(2);
    expect(c.caps.maxIterationsPerSession).toBe(5);
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a string", "5" as unknown as number],
    ["null", null as unknown as number],
    ["a fraction", 2.5],
  ])("rejects a session limit that is %s", (_name, bad) => {
    expect(() => loadWorkConfig({ caps: { maxSessions: bad } })).toThrow(RangeError);
  });

  test.each(["maxIterationsPerSession", "sessionWallMs", "workWallMs"] as const)("rejects a non-positive %s", (key) => {
    expect(() => loadWorkConfig({ caps: { [key]: 0 } })).toThrow(RangeError);
    expect(() => loadWorkConfig({ caps: { [key]: Number.NaN } })).toThrow(RangeError);
  });

  test("rejects an unknown cap name instead of ignoring it", () => {
    expect(() => loadWorkConfig({ caps: { maxSession: 9 } as never })).toThrow(RangeError);
  });

  test("rejects an empty author, provider or model", () => {
    expect(() => loadWorkConfig({ author: "" })).toThrow(RangeError);
    expect(() => loadWorkConfig({ provider: " " })).toThrow(RangeError);
    expect(() => loadWorkConfig({ model: "" })).toThrow(RangeError);
  });

  test("a per-session wall limit above the per-work wall limit is rejected", () => {
    expect(() => loadWorkConfig({ caps: { sessionWallMs: 40 * 60_000 } })).toThrow(RangeError);
  });
});

describe("parseStoredCaps", () => {
  test("round-trips a materialised record", () => {
    expect(parseStoredCaps(JSON.stringify(DEFAULT_CAPS))).toEqual(DEFAULT_CAPS);
  });

  test("a stored record that lacks a key is rejected, not defaulted", () => {
    expect(() => parseStoredCaps(JSON.stringify({ maxSessions: 3 }))).toThrow(RangeError);
  });

  test("a stored record with a bad value or bad JSON is rejected", () => {
    expect(() => parseStoredCaps(JSON.stringify({ ...DEFAULT_CAPS, workWallMs: -5 }))).toThrow(RangeError);
    expect(() => parseStoredCaps("{not json")).toThrow(RangeError);
  });
});
