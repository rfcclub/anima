import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomConfig } from "../src/config/types";

// Real factory execution lives in a fresh process: importing its defaults must
// never bind this test process to an operator HOME or a shared module mock.
async function probeFactory(config: RoomConfig, forceFailure = false): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "store-registry-fixture-"));
  try {
    mkdirSync(join(home, "work/abel-mem/data"), { recursive: true });
    const child = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "fixtures/store-registry-probe.ts"),
      home,
      forceFailure ? "fixture-fail" : JSON.stringify(config),
    ], {
      env: {
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        HOME: home,
        ANIMA_HOME: home,
        ANIMA_COST_DB: ":memory:",
        TZ: "UTC",
        NODE_ENV: "test",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    });
    if (child.exitCode !== 0) {
      throw Error(`fixture child refused: ${new TextDecoder().decode(child.stderr)}`);
    }
    const result = JSON.parse(new TextDecoder().decode(child.stdout));
    expect(result.home).toBe(home);
    expect(result.parentSecretPresent).toBe(false);
    expect(result.healthRegistered).toBe(result.type !== "undefined");
    return result.type;
  } finally {
    rmSync(home, { recursive: true, force: true });
    expect(existsSync(home)).toBe(false);
  }
}

function makeConfig(
  name: string,
  crossSessionBootstrap = true,
): RoomConfig {
  return {
    identity: { name, label: name },
    provider: { type: "claude" },
    policy: { allowedRoots: ["/tmp"] },
    session: { defaultMode: "plan", autoModeOptIn: false, compactThreshold: 60000 },
    boot: { gene: "PREFACE.md", sessionContext: [] },
    memory: crossSessionBootstrap
      ? { crossSessionBootstrap: true }
      : undefined,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createAgentMemoryStore", () => {
  test("returns AbelMemBunAdapter for abel agent", async () => {
    const store = await probeFactory(makeConfig("abel"));
    expect(store).toBe("AbelMemBunAdapter");
  });

  test("returns AnimaEntityStore for cleo agent", async () => {
    const store = await probeFactory(makeConfig("cleo"));
    expect(store).toBe("AnimaEntityStore");
  });

  test("returns BrunoEntityAdapter for bruno agent", async () => {
    const store = await probeFactory(makeConfig("bruno"));
    expect(store).toBe("BrunoEntityAdapter");
  });

  test("returns AnimaEntityStore for standard colony agents", async () => {
    // hana is a standard agent — uses AnimaEntityStore
    const store = await probeFactory(makeConfig("hana"));
    expect(store).toBe("AnimaEntityStore");
  });

  test("returns AnimaEntityStore for lena", async () => {
    const store = await probeFactory(makeConfig("lena"));
    expect(store).toBe("AnimaEntityStore");
  });

  test("returns AnimaEntityStore for milo", async () => {
    const store = await probeFactory(makeConfig("milo"));
    expect(store).toBe("AnimaEntityStore");
  });

  test("returns AnimaEntityStore for nora", async () => {
    const store = await probeFactory(makeConfig("nora"));
    expect(store).toBe("AnimaEntityStore");
  });

  test("returns AnimaEntityStore for pia", async () => {
    const store = await probeFactory(makeConfig("pia"));
    expect(store).toBe("AnimaEntityStore");
  });

  test("returns undefined when crossSessionBootstrap is not set", async () => {
    const store = await probeFactory(makeConfig("hana", false));
    expect(store).toBe("undefined");
  });

  test("returns undefined when memory config is absent", async () => {
    const config = makeConfig("hana", false);
    config.memory = undefined;
    const store = await probeFactory(config);
    expect(store).toBe("undefined");
  });
});

test("regression: parent credentials are forbidden and failed children leave no fixture state", async () => {
  const key = "ANIMA_FIXTURE_PARENT_SECRET";
  const previous = process.env[key];
  process.env[key] = "synthetic-store-canary";
  try {
    expect(await probeFactory(makeConfig("hana"))).toBe("AnimaEntityStore");
    await expect(probeFactory(makeConfig("hana"), true)).rejects.toThrow("intentional fixture failure before import");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("fixture root mismatch is forbidden before memory imports", () => {
  const root = mkdtempSync(join(tmpdir(), "store-root-guard-"));
  try {
    const child = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "fixtures/store-registry-probe.ts"),
      root,
      "invalid-json-would-fail-after-import-guard",
    ], {
      env: { PATH: process.env.PATH ?? "", HOME: root, ANIMA_HOME: join(root, "wrong") },
      stdout: "pipe", stderr: "pipe", timeout: 10000,
    });
    expect(child.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(child.stderr)).toContain("fixture root guard refused before import");
    expect(existsSync(join(root, ".anima"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
