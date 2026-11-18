import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

describe("SC-004 (feature-pages-as-tsx): CostPage", () => {
  test("is a React page that calls /api/cost, no inline script", () => {
    expect(existsSync("src/ui/features/cost/pages/CostPage.tsx")).toBe(true);
    const src = readFileSync("src/ui/features/cost/pages/CostPage.tsx", "utf8");
    expect(src).toContain("export function CostPage");
    expect(src).toContain("/api/cost");
    expect(src).not.toContain("<script>");
  });
});
