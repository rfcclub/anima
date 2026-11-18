import { expect, test } from "bun:test";
import { pulseAnimaHealthField } from "./pulse-readiness";

test("the pulse health field reflects scheduler readiness", () => {
  expect(pulseAnimaHealthField(true)).toBe("running");
  expect(pulseAnimaHealthField(false)).toBe("unavailable");
});
