import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";

describe("SC-002 (spa-shell + tailwind-adoption): SPA shell + tailwind root css", () => {
  test("src/ui/index.html exists and is the React mount", () => {
    const html = readFileSync("src/ui/index.html", "utf8");
    expect(html).toContain('<div id="root">');
    expect(html).toContain("./app/main.tsx");
    // no inline feature script (only the module loader)
    expect(html).not.toMatch(/<script>[^<]/);
  });

  test("tailwind.css imports tailwind", () => {
    const css = readFileSync("src/ui/styles/tailwind.css", "utf8");
    expect(css).toContain('@import "tailwindcss"');
  });

  test("tailwind.css declares agent brand color tokens", () => {
    const css = readFileSync("src/ui/styles/tailwind.css", "utf8");
    expect(css).toContain("--color-bruno");
    expect(css).toContain("--color-eli");
  });
});
