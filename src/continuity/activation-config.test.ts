import { expect, test } from "bun:test";
import { canRollbackActivation, parseActivationMode } from "./activation-config";

test("migration mode defaults off and rejects unknown values", () => {
  expect(parseActivationMode(undefined)).toBe("off");
  expect(parseActivationMode("shadow")).toBe("shadow");
  expect(() => parseActivationMode("unsafe")).toThrow();
});

test("rollback from gated modes requires drained leases", () => {
  expect(canRollbackActivation({ from: "enforce", to: "shadow", activeLeases: 1 })).toEqual({ ok: false, reason: "active-leases" });
  expect(canRollbackActivation({ from: "gate", to: "off", activeLeases: 0 })).toEqual({ ok: true });
  expect(canRollbackActivation({ from: "shadow", to: "off", activeLeases: 2 })).toEqual({ ok: true });
});
