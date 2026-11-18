import { describe, test, expect } from "bun:test";
import { fuzzyScore } from "../components/CommandPalette";

describe("fuzzyScore", () => {
  test("empty query matches everything with score 0", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  test("subsequence matches, non-subsequence does not", () => {
    expect(fuzzyScore("gtt", "Go to Town")).not.toBeNull();
    expect(fuzzyScore("xyz", "Go to Town")).toBeNull();
  });

  test("tighter matches score lower (better)", () => {
    const tight = fuzzyScore("town", "town hall")!;
    const loose = fuzzyScore("town", "the old wooden nave")!;
    expect(tight).toBeLessThan(loose);
  });

  test("case-insensitive", () => {
    expect(fuzzyScore("TOWN", "go to town")).not.toBeNull();
  });
});
