import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

describe("SC-001 (feature-pages-as-tsx): TownPage", () => {
  test("is a .tsx page component that re-exports the town App", () => {
    expect(existsSync("src/ui/features/town/pages/TownPage.tsx")).toBe(true);
    const src = readFileSync("src/ui/features/town/pages/TownPage.tsx", "utf8");
    expect(src).toContain("export function TownPage");
    expect(src).toContain("App");
  });
});
