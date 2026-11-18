import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

describe("SC-001 (tailwind-adoption): Phase 0 dependencies", () => {
  test("react-router-dom is a dependency", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(all["react-router-dom"]).toBeTruthy();
    expect(all["react"]).toBeTruthy();
    expect(all["react-dom"]).toBeTruthy();
  });

  test("tailwindcss is a dependency", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(all["tailwindcss"]).toBeTruthy();
  });
});
