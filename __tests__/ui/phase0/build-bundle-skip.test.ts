import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Regression: in prod, the ANIMA server runs from ~/.anima/ where ui/ has been
// rsync'd but the sibling source dirs it imports (narrative/, agents/, ...)
// have NOT. buildClientBundle() ran Bun.build at boot with CWD=~/.anima/, so
// the `../../../../narrative/vn-response` import (and every other ui/→src/
// escape) failed to resolve — logging "ui bundle build failed — serving stale
// or unbundled UI" every boot. deploy.sh already builds the bundle correctly
// (CWD=repo), so the boot build is redundant in prod and only ever fails there.
//
// Fix: buildClientBundle(uiDir) MUST no-op when a bundle already exists at
// uiDir/dist/index.html (the prod case — built by deploy.sh). It only builds
// when the dist is missing (dev cold-start).
describe("buildClientBundle boot-build skip", () => {
  let tmpUi: string;

  beforeEach(() => {
    tmpUi = mkdtempSync(join(tmpdir(), "anima-ui-"));
  });

  afterEach(async () => {
    await rm(tmpUi, { recursive: true, force: true }).catch(() => {});
  });

  test("skips build when dist/index.html already exists (prod: deploy.sh built it)", async () => {
    // Seed a minimal ui/ + a pre-built dist/index.html (simulating deploy.sh output)
    await writeFile(join(tmpUi, "index.html"), "<html></html>");
    await mkdir(join(tmpUi, "dist"), { recursive: true });
    await writeFile(join(tmpUi, "dist", "index.html"), "<html>built</html>");
    // Drop a deliberately-broken main.tsx so a real build WOULD fail — proving
    // we skipped rather than built.
    await mkdir(join(tmpUi, "app"), { recursive: true });
    await writeFile(join(tmpUi, "app", "main.tsx"), "import \"does-not-exist-xyz\";");

    const { buildClientBundle } = await import("../../../src/ui/app/server");
    // Should resolve without building (skip path), leaving the existing dist intact.
    await expect(buildClientBundle(tmpUi)).resolves.toBeUndefined();
    // The pre-built dist/index.html must be untouched (not rebuilt).
    expect(readFileSync(join(tmpUi, "dist", "index.html"), "utf8")).toBe("<html>built</html>");
    // And no broken app build artifacts leaked into dist.
    expect(existsSync(join(tmpUi, "dist", "index.html"))).toBe(true);
  });

  test("builds when dist/index.html is missing (dev cold-start)", async () => {
    await writeFile(join(tmpUi, "index.html"), '<html><body><script type="module" src="./app/main.tsx"></script></body></html>');
    await mkdir(join(tmpUi, "app"), { recursive: true });
    await writeFile(join(tmpUi, "app", "main.tsx"), "export default () => null;\n");

    const { buildClientBundle } = await import("../../../src/ui/app/server");
    await buildClientBundle(tmpUi);
    expect(existsSync(join(tmpUi, "dist", "index.html"))).toBe(true);
  });
});

void mkdtemp;
