import { describe, it, expect } from "vitest";
import {
  detectActionIntent,
  filterConfirmRules,
  formatConfirmGate,
} from "../src/confirm-gate.js";

const ruleEntry = (id: string, content: string) => ({
  id,
  content,
  scope: "heuristic",
  tags: [] as string[],
  confidence: 0.9,
  source: "test",
  createdAt: "2026-08-20T00:00:00.000Z",
});

describe("detectActionIntent", () => {
  it("flags imperative action commands", () => {
    expect(detectActionIntent("s\u1eeda \u0111i")).toBe(true);
    expect(detectActionIntent("em s\u1eeda wiring hook th\u00e0nh gate \u0111i")).toBe(true);
    expect(detectActionIntent("x\u00f3a file \u0111\u00f3 \u0111i")).toBe(true);
    expect(detectActionIntent("ch\u1ea1y l\u1ec7nh n\u00e0y gi\u00fap em")).toBe(true);
    expect(detectActionIntent("update config l\u00ean production")).toBe(true);
    expect(detectActionIntent("rm -rf ~/test")).toBe(true);
  });

  it("does not flag pure questions or chit-chat", () => {
    expect(detectActionIntent("anh th\u1ea5y sao?")).toBe(false);
    expect(detectActionIntent("em ph\u00e2n t\u00edch gi\u00fap anh")).toBe(false);
    expect(detectActionIntent("h\u00f4m nay th\u1ebf n\u00e0o?")).toBe(false);
    expect(detectActionIntent("k\u1ebft lu\u1eadn ch\u01b0a em?")).toBe(false);
  });
});

describe("filterConfirmRules", () => {
  const entries = [
    ruleEntry("20", "Tr\u01b0\u1edbc m\u1ed7i action kh\u00f4ng reversible: Destructive → confirm tr\u01b0\u1edbc. Shared state → h\u1ecfi tr\u01b0\u1edbc."),
    ruleEntry("13", "Rule: destructive action → ph\u1ea3i h\u1ecfi tr\u01b0\u1edbc. Shared state → confirm tr\u01b0\u1edbc."),
    ruleEntry("10", "### Directness\n- Tr\u1ea3 l\u1eddi tr\u1ef1c ti\u1ebfp c\u00e2u h\u1ecfi\n- Kh\u00f4ng wrap trong fluff"),
    ruleEntry("137", "Hardware veto: ch\u01b0a build."),
  ];

  it("keeps rules that require confirmation before action", () => {
    const hits = filterConfirmRules(entries);
    const ids = hits.map((e) => e.id);
    expect(ids).toContain("20");
    expect(ids).toContain("13");
  });

  it("drops rules unrelated to confirm-before-action", () => {
    const ids = filterConfirmRules(entries).map((e) => e.id);
    expect(ids).not.toContain("10");
    expect(ids).not.toContain("137");
  });

  it("returns empty array when no rule matches", () => {
    expect(filterConfirmRules([ruleEntry("10", "Directness: tr\u1ea3 l\u1eddi th\u1eb3ng.")])).toEqual([]);
  });
});

describe("formatConfirmGate", () => {
  it("renders gate header with recalled rules", () => {
    const out = formatConfirmGate([ruleEntry("20", "Destructive → confirm tr\u01b0\u1edbc.")]);
    expect(out).toContain("Confirm-Before-Action");
    expect(out).toContain("ask Owner to confirm");
    expect(out).toContain("Destructive → confirm tr\u01b0\u1edbc.");
  });

  it("returns null for empty hits", () => {
    expect(formatConfirmGate([])).toBeNull();
  });
});
