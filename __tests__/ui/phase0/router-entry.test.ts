import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const ROUTES = [
  "/", "/castle", "/cost", "/vn-assets", "/narrative",
  "/hall", "/library", "/observatory", "/forge", "/bodega", "/bridge",
  "/logs",
];

describe("SC-004/005/009 (spa-shell): SPA entry + router", () => {
  test("main.tsx mounts createRoot with BrowserRouter", () => {
    const src = readFileSync("src/ui/app/main.tsx", "utf8");
    expect(src).toContain("createRoot");
    expect(src).toContain("BrowserRouter");
    expect(src).toContain("App");
  });

  test("router.tsx maps every public route", () => {
    const src = readFileSync("src/ui/app/routes.tsx", "utf8");
    for (const route of ROUTES) {
      expect(src).toContain(route);
    }
  });

  test("router has a not-found fallback route", () => {
    const src = readFileSync("src/ui/app/routes.tsx", "utf8");
    expect(src).toContain('path="*"');
  });
});
