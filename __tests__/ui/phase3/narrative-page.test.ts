import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

describe("SC-006 (feature-pages-as-tsx): NarrativePage", () => {
  test("is a React page browsing VN branches, no inline script", () => {
    expect(existsSync("src/ui/features/vn-assets/pages/NarrativePage.tsx")).toBe(true);
    const src = readFileSync("src/ui/features/vn-assets/pages/NarrativePage.tsx", "utf8");
    expect(src).toContain("export function NarrativePage");
    expect(src).toContain("/api/vn/choices/");
    expect(src).not.toContain("<script>");
  });
});
