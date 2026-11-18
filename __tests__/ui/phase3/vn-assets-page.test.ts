import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

describe("SC-005 (feature-pages-as-tsx): VnAssetsPage", () => {
  test("is a React page performing VN asset CRUD, no inline script", () => {
    expect(existsSync("src/ui/features/vn-assets/pages/VnAssetsPage.tsx")).toBe(true);
    const src = readFileSync("src/ui/features/vn-assets/pages/VnAssetsPage.tsx", "utf8");
    expect(src).toContain("export function VnAssetsPage");
    expect(src).toContain("/api/vn/assets");
    expect(src).not.toContain("<script>");
  });
});
