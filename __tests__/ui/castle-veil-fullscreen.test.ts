import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The map's HTML layer is the 1920x1080 canvas letterboxed ("contain") inside the
// window, while the painting behind it fills the whole window. A veil that stays
// inside the layer leaves an undimmed strip beside the canvas on any window that
// is not 16:9, so the veil must spill past its own box in the same colour.
const css = readFileSync(join(import.meta.dir, "../../src/ui/styles/tailwind.css"), "utf8");

function rule(selector: string): string {
  const match = css.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*(?:\\([^)]*\\)[^}]*)*)\\}`));
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1]!;
}

test("hover veil spills past the letterboxed canvas so the whole window darkens", () => {
  const veil = rule(".castle-veil");
  const edge = veil.match(/color-mix\(in srgb, var\(--color-castle-bg\) (\d+)%, transparent\) 100%\)/);
  expect(edge).not.toBeNull();
  const spill = veil.match(/box-shadow:\s*0 0 0 100vmax color-mix\(in srgb, var\(--color-castle-bg\) (\d+)%, transparent\)/);
  expect(spill).not.toBeNull();
  expect(spill![1]).toBe(edge![1]);
});
