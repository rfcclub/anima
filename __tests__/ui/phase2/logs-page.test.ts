import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

describe("SC-007 (feature-pages-as-tsx): LogsPage", () => {
  test("is a React page using /api/logs and /api/logs/stream, no inline script", () => {
    expect(existsSync("src/ui/features/logs/pages/LogsPage.tsx")).toBe(true);
    const src = readFileSync("src/ui/features/logs/pages/LogsPage.tsx", "utf8");
    expect(src).toContain("export function LogsPage");
    expect(src).toContain("/api/logs");
    expect(src).toContain("/api/logs/stream");
    expect(src).not.toContain("<script>");
  });
});
