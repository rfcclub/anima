import { test, expect } from "bun:test";
import { positionToXAlign } from "../../src/ui/features/castle/engine/room-stage";

test("maps the five named slots", () => {
  expect(positionToXAlign("left")).toBe(0.12);
  expect(positionToXAlign("center-left")).toBe(0.31);
  expect(positionToXAlign("center")).toBe(0.5);
  expect(positionToXAlign("center-right")).toBe(0.69);
  expect(positionToXAlign("right")).toBe(0.94);
});

test("defaults unknown positions to center", () => {
  expect(positionToXAlign("offstage" as never)).toBe(0.5);
  expect(positionToXAlign(undefined)).toBe(0.5);
});
