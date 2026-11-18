import { describe, expect, test } from "bun:test";
import { detectReboot } from "../src/session/boot-id";

describe("boot-id", () => {
  test("detectReboot returns non-empty currentBootId on linux", () => {
    if (process.platform !== "linux") return;
    const result = detectReboot();
    expect(result.currentBootId).toBeTruthy();
    expect(typeof result.isReboot).toBe("boolean");
  });

  test("detectReboot returns isReboot false on non-linux", () => {
    // If we're on linux, this test is skipped
    if (process.platform === "linux") return;
    const result = detectReboot();
    expect(result.isReboot).toBe(false);
  });
});
