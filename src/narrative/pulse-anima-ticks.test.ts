import { test, expect } from "bun:test";
import {
  matchPulseAnimaTick,
  matchPulseAnimaTickByIntegrate,
  matchPulseAnimaTickByIntegrateAndDream,
  animaComboFileName,
  PULSE_ANIMA_TICKS,
} from "./pulse-anima-ticks";

test("matches each of the 4 known ticks regardless of occupant array order", () => {
  expect(matchPulseAnimaTick(["ivan", "dana", "finn", "abel"])).toBe(1);
  expect(matchPulseAnimaTick(["abel", "finn", "dana", "ivan"])).toBe(1);
  expect(matchPulseAnimaTick(["rhea", "cleo", "eli", "hana"])).toBe(2);
  expect(matchPulseAnimaTick(["gus", "nora", "sam", "lena"])).toBe(3);
  expect(matchPulseAnimaTick(["milo", "kai", "pia", "bruno"])).toBe(4);
});

test("returns null for a non-tick combination of 4 agents", () => {
  expect(matchPulseAnimaTick(["bruno", "eli", "lena", "nora"])).toBeNull();
});

test("returns null when the occupant count isn't exactly 4", () => {
  expect(matchPulseAnimaTick([])).toBeNull();
  expect(matchPulseAnimaTick(["ivan"])).toBeNull();
  expect(matchPulseAnimaTick(["ivan", "dana", "finn", "abel", "bruno"])).toBeNull();
});

test("PULSE_ANIMA_TICKS has exactly 4 ticks of 4 agents each, all distinct agents", () => {
  expect(PULSE_ANIMA_TICKS).toHaveLength(4);
  const all = PULSE_ANIMA_TICKS.flat();
  expect(new Set(all).size).toBe(16);
});

test("matchPulseAnimaTickByIntegrate resolves a tick from the integrate agent alone", () => {
  expect(matchPulseAnimaTickByIntegrate("abel")).toBe(1);
  expect(matchPulseAnimaTickByIntegrate("hana")).toBe(2);
  expect(matchPulseAnimaTickByIntegrate("lena")).toBe(3);
  expect(matchPulseAnimaTickByIntegrate("bruno")).toBe(4);
});

test("matchPulseAnimaTickByIntegrate ignores the other 3 roles' drift entirely", () => {
  // Occupants {abel, ivan, kai, pia} mix Tick 1's {ivan, abel} and Tick 4's
  // {kai, pia}, so they match neither tick under matchPulseAnimaTick's
  // exact-set rule.
  expect(matchPulseAnimaTick(["abel", "ivan", "kai", "pia"])).toBeNull();
  expect(matchPulseAnimaTickByIntegrate("abel")).toBe(1);
});

test("matchPulseAnimaTickByIntegrate returns null for a non-integrate agent or no agent", () => {
  expect(matchPulseAnimaTickByIntegrate("ivan")).toBeNull();
  expect(matchPulseAnimaTickByIntegrate(null)).toBeNull();
});

test("matchPulseAnimaTickByIntegrateAndDream matches only the real pairing of the two roles", () => {
  expect(matchPulseAnimaTickByIntegrateAndDream("abel", "finn")).toBe(1);
  expect(matchPulseAnimaTickByIntegrateAndDream("hana", "eli")).toBe(2);
  expect(matchPulseAnimaTickByIntegrateAndDream("lena", "sam")).toBe(3);
  expect(matchPulseAnimaTickByIntegrateAndDream("bruno", "pia")).toBe(4);
  // integrate=abel's real tick pairs with dream=finn, not dream=eli (Tick 2's).
  expect(matchPulseAnimaTickByIntegrateAndDream("abel", "eli")).toBeNull();
  expect(matchPulseAnimaTickByIntegrateAndDream(null, "finn")).toBeNull();
  expect(matchPulseAnimaTickByIntegrateAndDream("abel", null)).toBeNull();
});

test("animaComboFileName builds the integrate_dream combo scene id, order preserved (not sorted)", () => {
  // 12 combo images cover every integrate x dream pairing except the 4 that
  // already share a real tick (those keep using anima_batchN — a strictly
  // better match, both roles' faces are correct). Filename convention:
  // anima_<integrateAgent>_<dreamAgent>.png — integrate first, not sorted.
  expect(animaComboFileName("abel", "pia")).toBe("anima_abel_pia");
  expect(animaComboFileName("hana", "finn")).toBe("anima_hana_finn");
  // Order matters — swapping would look for a file that doesn't exist.
  expect(animaComboFileName("finn", "hana")).toBe("anima_finn_hana");
});

test("animaComboFileName returns null when either role is unknown", () => {
  expect(animaComboFileName(null, "finn")).toBeNull();
  expect(animaComboFileName("abel", null)).toBeNull();
  expect(animaComboFileName(null, null)).toBeNull();
});
