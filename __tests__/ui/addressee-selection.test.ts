import { test, expect } from "bun:test";
import { selectAddressee, selectAll, selectOrder, addresseeField, computeSwapOrder, computeOrderingOptions, type Addressee } from "../../src/ui/features/castle/lib/addressee-selection";

// ── selectAddressee / selectAll / addresseeField (SC-004, SC-005, SC-006) ──

test("SC-004: selecting a new occupant replaces the previous selection", () => {
  const a1 = selectAddressee({ kind: "none" }, "bruno");
  expect(a1).toEqual({ kind: "agent", id: "bruno" });
  const a2 = selectAddressee(a1, "eli");
  expect(a2).toEqual({ kind: "agent", id: "eli" });
});

test("SC-005: addresseeField reflects the current sticky selection", () => {
  const a: Addressee = { kind: "agent", id: "bruno" };
  expect(addresseeField(a)).toBe("bruno");
});

test("SC-006: selecting 'all' clears any individual addressee selection", () => {
  const withAgent: Addressee = { kind: "agent", id: "bruno" };
  const all = selectAll();
  expect(all).toEqual({ kind: "all" });
  expect(all).not.toEqual(withAgent);
});

test("addresseeField: none → undefined", () => {
  expect(addresseeField({ kind: "none" })).toBeUndefined();
});

test("addresseeField: all → 'all'", () => {
  expect(addresseeField({ kind: "all" })).toBe("all");
});

// ── computeSwapOrder ──────────────────────────────────────────────────────

test("computeSwapOrder: swaps clicked agent into index 0, swaps prior occupant of index 0 into its slot", () => {
  expect(computeSwapOrder(["eli", "bruno", "lena"], "lena")).toEqual(["lena", "bruno", "eli"]);
});

test("computeSwapOrder: clicked agent already at index 0 → no-op", () => {
  expect(computeSwapOrder(["eli", "bruno"], "eli")).toEqual(["eli", "bruno"]);
});

test("computeSwapOrder: clicked agent not present → no-op", () => {
  expect(computeSwapOrder(["eli", "bruno"], "lena")).toEqual(["eli", "bruno"]);
});

test("computeSwapOrder: two-element swap", () => {
  expect(computeSwapOrder(["eli", "bruno"], "bruno")).toEqual(["bruno", "eli"]);
});

// ── selectOrder / computeOrderingOptions ────────────

test("selectOrder: sets an explicit order, clearing any prior selection", () => {
  const a = selectOrder(["bruno", "eli"]);
  expect(a).toEqual({ kind: "order", order: ["bruno", "eli"] });
});

test("addresseeField: order → comma-joined", () => {
  expect(addresseeField({ kind: "order", order: ["bruno", "eli"] })).toBe("bruno,eli");
});

test("computeOrderingOptions: 2 occupants → owner-led and guest-led options", () => {
  expect(computeOrderingOptions(["eli", "bruno"], "eli")).toEqual([
    ["eli", "bruno"],
    ["bruno", "eli"],
  ]);
});

test("computeOrderingOptions: 3 occupants → owner-led + each guest-led (guest, owner, other guest)", () => {
  expect(computeOrderingOptions(["eli", "bruno", "lena"], "eli")).toEqual([
    ["eli", "bruno", "lena"],
    ["bruno", "eli", "lena"],
    ["lena", "eli", "bruno"],
  ]);
});

test("computeOrderingOptions: owner alone → no options", () => {
  expect(computeOrderingOptions(["eli"], "eli")).toEqual([]);
});

test("computeOrderingOptions: owner ABSENT, only a guest present → no options", () => {
  // Bruno's room, Bruno away, only Lena present — must NOT fabricate
  // "Bruno-Lena" / "Lena-Bruno" orderings for an owner who isn't there.
  expect(computeOrderingOptions(["lena"], "bruno")).toEqual([]);
});

test("computeOrderingOptions: owner absent, 2 guests present → no options either", () => {
  expect(computeOrderingOptions(["lena", "eli"], "bruno")).toEqual([]);
});

test("computeOrderingOptions: capped at 3 options even with 4+ occupants", () => {
  const options = computeOrderingOptions(["eli", "bruno", "lena", "cleo"], "eli");
  expect(options.length).toBe(3);
});

// ── reconcileAddressee (SC-301..305) — reset stale selection vs live occupants ──

import { reconcileAddressee } from "../../src/ui/features/castle/lib/addressee-selection";

test("SC-301: ordered member departs (only 1 remains) → reset to none", () => {
  expect(reconcileAddressee({ kind: "order", order: ["lena", "bruno"] }, ["bruno"])).toEqual({ kind: "none" });
});

test("SC-302: ordered members all stay → preserved unchanged", () => {
  expect(reconcileAddressee({ kind: "order", order: ["bruno", "lena"] }, ["bruno", "lena"])).toEqual({ kind: "order", order: ["bruno", "lena"] });
});

test("SC-303: partial survival (2 of 3 remain) → trimmed, keeps relative order", () => {
  expect(reconcileAddressee({ kind: "order", order: ["bruno", "lena", "eli"] }, ["bruno", "eli"])).toEqual({ kind: "order", order: ["bruno", "eli"] });
});

test("SC-304: clicked agent departs → reset to none", () => {
  expect(reconcileAddressee({ kind: "agent", id: "lena" }, ["bruno"])).toEqual({ kind: "none" });
});

test("SC-305: clicked agent stays → preserved", () => {
  expect(reconcileAddressee({ kind: "agent", id: "lena" }, ["bruno", "lena"])).toEqual({ kind: "agent", id: "lena" });
});

test("reconcileAddressee: none and all pass through unchanged", () => {
  expect(reconcileAddressee({ kind: "none" }, ["bruno"])).toEqual({ kind: "none" });
  expect(reconcileAddressee({ kind: "all" }, ["bruno"])).toEqual({ kind: "all" });
});

// ── RoomScreen stage derivation via reconcileAddressee (SC-301, SC-304) ───
// The stage list must use the reconciled selection (order filtered to live
// occupants), not the raw addressee.order — so a departed member's sprite
// is never drawn. This tests the pure derivation the component uses.

test("SC-301: stage excludes departed ordered member via reconcile", () => {
  const addressee = { kind: "order" as const, order: ["lena", "bruno"] };
  const occupants = ["bruno"]; // lena departed
  const reconciled = reconcileAddressee(addressee, occupants);
  expect(reconciled).toEqual({ kind: "none" });
  // stageAgents falls back to occupants when none → only bruno on stage
  expect(reconciled.kind === "none" ? occupants : []).toEqual(["bruno"]);
});

test("SC-304: stage excludes departed clicked agent via reconcile", () => {
  const addressee = { kind: "agent" as const, id: "lena" };
  const occupants = ["bruno"]; // lena departed
  const reconciled = reconcileAddressee(addressee, occupants);
  expect(reconciled).toEqual({ kind: "none" });
});
