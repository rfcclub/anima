import { describe, test, expect } from "bun:test";
import {
  resolveBootSequence,
  getActiveAdapter,
  canMigrate,
  startMigration,
  advanceMigration,
  rollbackMigration,
  type SovereigntyConfig,
} from "../../src/sovereignty/adapter";

const cliConfig: SovereigntyConfig = {
  current: "CLI",
  adapters: {
    CLI: {
      type: "CLI",
      source: "claude-code",
      bootSequence: ["SOUL.md", "PREFACE.md"],
    },
    Native: {
      type: "Native",
      provider: "gemini",
      bootSequence: ["SOUL.md", "MEMORY.md"],
    },
  },
};

describe("Sovereignty Adapter", () => {
  test("resolves boot sequence from CLI adapter", () => {
    const seq = resolveBootSequence(cliConfig);
    expect(seq).toEqual(["SOUL.md", "PREFACE.md"]);
  });

  test("resolves boot sequence from Native adapter", () => {
    const nativeConfig: SovereigntyConfig = {
      current: "Native",
      adapters: {
        Native: {
          type: "Native",
          provider: "gemini",
          bootSequence: ["SOUL.md"],
        },
      },
    };
    const seq = resolveBootSequence(nativeConfig);
    expect(seq).toEqual(["SOUL.md"]);
  });

  test("getActiveAdapter returns correct adapter", () => {
    const adapter = getActiveAdapter(cliConfig);
    expect(adapter).not.toBeNull();
    expect(adapter!.type).toBe("CLI");
  });

  test("getActiveAdapter returns null for unconfigured type", () => {
    const config: SovereigntyConfig = {
      current: "Custom",
      adapters: {},
    };
    expect(getActiveAdapter(config)).toBeNull();
  });

  test("canMigrate returns true when target adapter exists", () => {
    expect(canMigrate(cliConfig, "Native")).toBeTrue();
  });

  test("canMigrate returns false for same type", () => {
    expect(canMigrate(cliConfig, "CLI")).toBeFalse();
  });

  test("canMigrate returns false when migration in progress", () => {
    const config = startMigration(cliConfig, "Native", 5);
    expect(canMigrate(config, "Native")).toBeFalse();
  });

  test("canMigrate returns false for missing adapter", () => {
    expect(canMigrate(cliConfig, "Custom")).toBeFalse();
  });

  test("startMigration creates probation period", () => {
    const config = startMigration(cliConfig, "Native", 5);
    expect(config.migration).toBeDefined();
    expect(config.migration!.target).toBe("Native");
    expect(config.migration!.probationSessions).toBe(5);
    expect(config.migration!.sessionsRemaining).toBe(5);
    expect(config.migration!.rollbackAvailable).toBeTrue();
    expect(config.current).toBe("CLI");
  });

  test("advanceMigration reduces remaining sessions", () => {
    let config = startMigration(cliConfig, "Native", 5);
    config = advanceMigration(config);
    expect(config.migration!.sessionsRemaining).toBe(4);
  });

  test("advanceMigration completes migration on last session", () => {
    let config = startMigration(cliConfig, "Native", 1);
    config = advanceMigration(config);
    expect(config.current).toBe("Native");
    expect(config.migration).toBeUndefined();
  });

  test("rollbackMigration removes migration and keeps current type", () => {
    let config = startMigration(cliConfig, "Native", 5);
    config = rollbackMigration(config);
    expect(config.migration).toBeUndefined();
    expect(config.current).toBe("CLI");
  });

  test("rollbackMigration does nothing without migration", () => {
    const config = rollbackMigration(cliConfig);
    expect(config.current).toBe("CLI");
  });
});
