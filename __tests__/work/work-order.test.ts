/**
 * cartridge-worker-dispatch: the work order and cartridge requirements, built apart
 * from execution. Pure functions; no process, store or network.
 */

import { test, expect, describe } from "bun:test";
import { buildWorkOrder, checkRequirements, type AdapterCapabilities, type WorkCartridge } from "../../src/work/work-order";

const external: AdapterCapabilities = { adapter: "external", tools: ["bash", "read", "write", "edit"], network: ["none", "gateway"], skills: false, writable: ["tree", "tmp", "home"] };
const loop: AdapterCapabilities = { adapter: "loop", tools: ["bash", "read", "write", "edit", "publish"], network: ["none"], skills: true, writable: ["tree", "tmp", "home"] };

const cartridge = (over: Partial<WorkCartridge> = {}): WorkCartridge => ({
  name: "ts-backend", modules: ["Prefer small pure functions.", "Run bun test before finishing."], skills: ["orca-verify"],
  requires: { tools: ["bash", "edit"], network: "gateway", writable: ["tree"] }, ...over,
});
const base = {
  work: { workId: "w1", repo: "rfcclub/anima", issue: 7, branch: "work/7-w1" },
  issue: { title: "Add the thing", body: "Make the thing." },
  kind: "start-work" as const,
  tree: "/tmp/w1/tree",
  budget: { maxIterations: 5, deadlineMs: 1_000 },
};

describe("work order (cartridge-worker-dispatch S3)", () => {
  test("explicit-cartridge-order: a named cartridge gives its prompt modules and only the skills it grants", () => {
    const order = buildWorkOrder({ ...base, adapter: { ...external, skills: true }, cartridge: cartridge() });
    expect(order.cartridge).toEqual({ name: "ts-backend", modules: ["Prefer small pure functions.", "Run bun test before finishing."], skills: ["orca-verify"] });
    expect(order.task).toEqual({ repo: "rfcclub/anima", issue: 7, branch: "work/7-w1", title: "Add the thing", body: "Make the thing.", kind: "start-work" });
    expect([order.tree, order.budget]).toEqual(["/tmp/w1/tree", { maxIterations: 5, deadlineMs: 1_000 }]);
    const none = buildWorkOrder({ ...base, adapter: external });
    expect(none.cartridge).toBeUndefined();
  });

  test("unsupported-requirement: an unmet requirement is named and no order is built", () => {
    expect(checkRequirements(cartridge().requires, external)).toEqual({ ok: true });
    expect(checkRequirements({ tools: ["browser"] }, external)).toEqual({ ok: false, unsupported: "tool:browser" });
    expect(checkRequirements({ network: "internet" }, external)).toEqual({ ok: false, unsupported: "network:internet" });
    expect(checkRequirements({ network: "gateway" }, loop)).toEqual({ ok: false, unsupported: "network:gateway" });
    expect(checkRequirements({ writable: ["/etc"] }, external)).toEqual({ ok: false, unsupported: "writable:/etc" });
    expect(checkRequirements({}, external)).toEqual({ ok: true });
    expect(checkRequirements(undefined, external)).toEqual({ ok: true });
    expect(() => buildWorkOrder({ ...base, adapter: external, cartridge: cartridge({ requires: { tools: ["browser"] } }) })).toThrow(/unsupported: tool:browser/);
  });

  test("no-identity: an external order carries no identity, recall or memory-write tool", () => {
    const order = buildWorkOrder({ ...base, adapter: external, cartridge: cartridge({ skills: [] }) });
    expect(Object.keys(order).sort()).toEqual(["budget", "cartridge", "evidence", "task", "tree"]);
    const text = JSON.stringify(order);
    for (const word of ["identity", "soul", "recall", "memory", "gene"]) expect(text.toLowerCase()).not.toContain(word);
    expect(order.evidence).toEqual(["commits", "tests"]);
  });

  test("handoff-is-data: a covered note is untrusted task data; a missing, uncovered or malformed note is left out", () => {
    const covered = buildWorkOrder({ ...base, adapter: external, handoff: { text: "Tests for the empty case remain.", covered: true } });
    expect(covered.handoff).toEqual({ text: "Tests for the empty case remain.", trust: "untrusted" });
    for (const handoff of [undefined, { text: "x", covered: false }, { text: "", covered: true }, { text: 42 as unknown as string, covered: true }, { text: "y".repeat(16_385), covered: true }]) {
      const order = buildWorkOrder({ ...base, adapter: external, handoff });
      expect(order.handoff).toBeUndefined();
    }
  });

  test("one-cartridge-two-adapters: the same cartridge builds for both adapters; skills an adapter cannot run are reported", () => {
    const forLoop = buildWorkOrder({ ...base, adapter: loop, cartridge: cartridge({ requires: { tools: ["bash"] } }) });
    expect(forLoop.cartridge?.skills).toEqual(["orca-verify"]);
    expect(checkRequirements({ skills: ["orca-verify"] }, external)).toEqual({ ok: false, unsupported: "skills:orca-verify" });
    expect(() => buildWorkOrder({ ...base, adapter: external, cartridge: cartridge() })).toThrow(/unsupported: skills:orca-verify/);
  });
});
