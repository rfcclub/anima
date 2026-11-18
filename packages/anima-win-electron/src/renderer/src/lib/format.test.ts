import { describe, test, expect } from "bun:test";
import { formatUptime } from "../components/Overview";

describe("formatUptime", () => {
  test("seconds and minutes", () => {
    expect(formatUptime(59)).toBe("0m 59s");
    expect(formatUptime(125)).toBe("2m 5s");
  });
  test("hours", () => {
    expect(formatUptime(3_661)).toBe("1h 1m");
  });
  test("days", () => {
    expect(formatUptime(90_061)).toBe("1d 1h 1m");
    // fractional seconds are truncated
    expect(formatUptime(57_036.135)).toBe("15h 50m");
  });
});
