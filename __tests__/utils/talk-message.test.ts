import { describe, expect, test } from "bun:test";
import { resolveTalkMessage } from "../../src/utils/talk-message";

describe("resolveTalkMessage", () => {
  test("a plain -m value is used as is, and stdin is not read", async () => {
    let reads = 0;
    expect(await resolveTalkMessage("hello", async () => { reads += 1; return "x"; })).toBe("hello");
    expect(reads).toBe(0);
  });

  test("-m - reads the message from stdin", async () => {
    const long = "y".repeat(200_000);
    expect(await resolveTalkMessage("-", async () => long)).toBe(long);
  });
});
