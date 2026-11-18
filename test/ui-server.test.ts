import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("canonical UI router: all18 legacy cases in a temporary-home child", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anima-ui-suite-"));
  try {
    const child = Bun.spawn([process.execPath, "test", "--isolate", "--preload",
      join(import.meta.dir, "fixtures/ui-server-preload.ts"),
      join(import.meta.dir, "fixtures/ui-server-cases.ts")], {
      cwd: directory, stdout: "pipe", stderr: "pipe", timeout: 20_000,
      env: {
        PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR ?? "/tmp", ELI_TEST_ROOT: directory,
        TZ: "UTC", NODE_ENV: "test", ANIMA_SHARED_CONVERSATIONS: "0",
        ANIMA_ACTIVATION_MODE: "off", ANIMA_COST_DB: ":memory:",
        ANIMA_STATE_DIR: join(directory, "state"), ANIMA_UI_STATE_DIR: join(directory, "ui"),
        ANIMA_ROOMS_DIR: join(directory, "rooms"),
      },
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ exit, stdout, stderr }).toMatchObject({ exit: 0 });
    expect(stdout + stderr).toMatch(/18 pass\s+0 fail/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 25_000);
