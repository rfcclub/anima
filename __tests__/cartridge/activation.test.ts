import { test, expect } from "bun:test";
import { buildSystemPrompt } from "../../src/agents/prompter";
import type { CartridgeBlock } from "../../src/cartridge/types";

function stubAgent(): any {
  return {
    name: "testa",
    label: "Test Agent",
    soulContent: "I am testa.",
    geneContent: "Do the work.",
    sessionContextFiles: [],
    additionalContent: [],
    additionalSessionContext: [],
    extraActionResults: [],
    bootstrapContent: "",
    config: {
      provider: { model: "m", type: "p" },
      session: { defaultMode: "plan" },
      policy: { allowedRoots: [], readOnlyRoots: [], allowedTools: [] },
      identity: {},
    },
  };
}

const block = (name: string, scope: string, content: string): CartridgeBlock =>
  ({ name, scope, category: "craft", content });

test("SC-020 base cartridges live in static prefix, hash stable", () => {
  const agent = stubAgent();
  const bases = [block("a", "shared", "BASE-A"), block("b", "shared", "BASE-B"), block("c", "agent", "BASE-C")];
  const p1 = buildSystemPrompt(agent, { baseCartridges: bases });
  const p2 = buildSystemPrompt(agent, { baseCartridges: bases });
  expect(p1.staticPrefix).toContain("BASE-A");
  expect(p1.staticPrefix).toContain("BASE-B");
  expect(p1.staticPrefix).toContain("BASE-C");
  expect(p1.staticHash).toBe(p2.staticHash);
});

test("SC-021 base cartridge order is deterministic regardless of input order", () => {
  const agent = stubAgent();
  const a = block("a", "shared", "BASE-A");
  const b = block("b", "agent", "BASE-B");
  const p1 = buildSystemPrompt(agent, { baseCartridges: [a, b] });
  const p2 = buildSystemPrompt(agent, { baseCartridges: [b, a] });
  expect(p1.staticPrefix).toBe(p2.staticPrefix);
  expect(p1.staticPrefix.indexOf("BASE-A")).toBeLessThan(p1.staticPrefix.indexOf("BASE-B"));
});

test("SC-022 plugging a cartridge does not change staticHash", () => {
  const agent = stubAgent();
  const bases = [block("a", "shared", "BASE-A")];
  const off = buildSystemPrompt(agent, { baseCartridges: bases });
  const on = buildSystemPrompt(agent, { baseCartridges: bases, activeCartridge: block("ts", "pluggable", "TS-CART") });
  expect(on.staticHash).toBe(off.staticHash);
  expect(on.dynamicSuffix).toContain("TS-CART");
  expect(off.dynamicSuffix).not.toContain("TS-CART");
});

test("SC-023 unplugging does not change staticHash", () => {
  const agent = stubAgent();
  const on = buildSystemPrompt(agent, { activeCartridge: block("ts", "pluggable", "TS-CART") });
  const off = buildSystemPrompt(agent, {});
  expect(on.staticHash).toBe(off.staticHash);
  expect(off.full).not.toContain("TS-CART");
});

test("SC-024 swap replaces, never stacks", () => {
  const agent = stubAgent();
  const py = buildSystemPrompt(agent, { activeCartridge: block("python", "pluggable", "PY-CART") });
  expect(py.full).toContain("PY-CART");
  expect(py.full).not.toContain("TS-CART");
});

import { CartridgeLoader } from "../../src/cartridge/loader";
import { CartridgeRegistry } from "../../src/cartridge/registry";
import { resolveActivation } from "../../src/cartridge/activation";
import { makeRoots, writeCartridge } from "./registry.test";

async function setup(extraFrontmatter = "", body = "TS BODY") {
  const roots = makeRoots();
  writeCartridge(roots.projectRoot, "shared", "base.md",
    "type: cartridge\nname: base\ncategory: craft", "BASE BODY");
  writeCartridge(roots.projectRoot, "pluggable", "typescript.md",
    `type: cartridge\nname: typescript\ncategory: craft${extraFrontmatter}`, body);
  writeCartridge(roots.projectRoot, "pluggable", "thinking.md",
    "type: cartridge\nname: thinking\ncategory: think", "THINK BODY");
  const registry = new CartridgeRegistry(roots);
  const entries = await registry.list("tester");
  return { registry, entries, loader: new CartridgeLoader() };
}

test("SC-025 explicit override wins over self-select", async () => {
  const { registry, entries, loader } = await setup();
  const r = await resolveActivation(registry, {
    entries, loader, mode: "plan", message: "hello",
    cartridgeOverride: "typescript",
    agentCartridgeConfig: { selfSelect: "create" },
  });
  expect(r.active?.name).toBe("typescript");
  expect(r.source).toBe("override");
});

test("SC-026 null override forces none", async () => {
  const { registry, entries, loader } = await setup();
  const r = await resolveActivation(registry, {
    entries, loader, mode: "edit", message: "please debug this",
    cartridgeOverride: null,
    agentCartridgeConfig: { taskPatterns: { craft: ["debug"] } },
  });
  expect(r.active).toBeUndefined();
});

test("SC-027 mode fallback resolves think category in plan mode", async () => {
  const { registry, entries, loader } = await setup();
  const r = await resolveActivation(registry, {
    entries, loader, mode: "plan", message: "hello",
  });
  expect(r.active?.name).toBe("thinking");
  expect(r.source).toBe("mode");
});

test("SC-028 activation event carries name, source, tokens", async () => {
  const { registry, entries, loader } = await setup();
  const r = await resolveActivation(registry, {
    entries, loader, mode: "edit", message: "please debug this",
    agentCartridgeConfig: { taskPatterns: { craft: ["debug"] } },
  });
  const evt = r.events.find((e) => e.type === "cartridge_activated")!;
  expect(evt.name).toBe("typescript");
  expect(evt.source).toBe("task");
  expect(typeof evt.estimatedTokens).toBe("number");
});

test("SC-008b/SC-029 over-budget pluggable dropped with warning event", async () => {
  const { registry, entries, loader } = await setup("\nbudget_tokens: 100", "x".repeat(4000));
  const r = await resolveActivation(registry, {
    entries, loader, mode: "plan", message: "hi",
    cartridgeOverride: "typescript",
  });
  expect(r.active).toBeUndefined();
  const evt = r.events.find((e) => e.type === "cartridge_budget_exceeded")!;
  expect(evt.budget).toBe(100);
  expect(evt.estimate as number).toBeGreaterThan(100);
});
