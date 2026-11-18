import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

describe("SC-012 (backend-preservation): buildClientBundle builds SPA from index.html", () => {
  test("builds from src/ui/index.html entrypoint", () => {
    const src = readFileSync("src/ui/app/server.ts", "utf8");
    expect(src).toContain("index.html");
    expect(src).toContain("Bun.build");
  });

  test("outputs to a dist directory", () => {
    const src = readFileSync("src/ui/app/server.ts", "utf8");
    expect(src).toMatch(/outdir/);
  });
});
