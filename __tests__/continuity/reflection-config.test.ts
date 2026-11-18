import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReflectionAgents } from "../../src/continuity/reflection-config";

let roomsDir: string;

function writeRoom(name: string, configYaml?: string) {
  const dir = join(roomsDir, name);
  mkdirSync(dir, { recursive: true });
  if (configYaml !== undefined) {
    writeFileSync(join(dir, "config.yaml"), configYaml);
  }
}

beforeEach(() => {
  roomsDir = mkdtempSync(join(tmpdir(), "reflection-config-"));
});

afterEach(() => {
  rmSync(roomsDir, { recursive: true, force: true });
});

describe("loadReflectionAgents", () => {
  test("accepts reflection.enabled shape (dana's shape)", async () => {
    writeRoom("dana", "reflection:\n  enabled: true\n  intervalMs: 43200000\n");

    const agents = await loadReflectionAgents(roomsDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("dana");
    expect(agents[0].reflectionEnabled).toBe(true);
    expect(agents[0].reflectionIntervalHours).toBe(12);
  });

  test("accepts session.reflectionEnabled shape (a real-world shape)", async () => {
    writeRoom(
      "bruno",
      "session:\n  maxTokens: 16384\n  reflectionEnabled: true\n  reflectionIntervalHours: 12\n",
    );

    const agents = await loadReflectionAgents(roomsDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("bruno");
    expect(agents[0].reflectionEnabled).toBe(true);
    expect(agents[0].reflectionIntervalHours).toBe(12);
  });

  test("reflection block wins over session block when both present", async () => {
    writeRoom(
      "both",
      "reflection:\n  enabled: true\n  intervalMs: 3600000\nsession:\n  reflectionEnabled: true\n  reflectionIntervalHours: 12\n",
    );

    const agents = await loadReflectionAgents(roomsDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].reflectionIntervalHours).toBe(1);
  });

  test("disabled and unconfigured rooms are skipped", async () => {
    writeRoom("off", "reflection:\n  enabled: false\n");
    writeRoom("sessionOff", "session:\n  reflectionEnabled: false\n");
    writeRoom("plain", "cartridges:\n  defaultRole: programmer\n");
    writeRoom("noconfig");

    const agents = await loadReflectionAgents(roomsDir);
    expect(agents).toHaveLength(0);
  });

  test("underscore dirs are ignored and parse errors don't break the scan", async () => {
    writeRoom("_meeting", "reflection:\n  enabled: true\n");
    writeRoom("broken", ":::not yaml:::[");
    writeRoom("good", "reflection:\n  enabled: true\n  intervalMs: 7200000\n");

    const agents = await loadReflectionAgents(roomsDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("good");
    expect(agents[0].reflectionIntervalHours).toBe(2);
  });

  test("carries urgencyThreshold and provider through", async () => {
    writeRoom(
      "dana",
      "provider:\n  name: anthropic\nreflection:\n  enabled: true\n  intervalMs: 3600000\n  urgencyThreshold: 5\n",
    );

    const agents = await loadReflectionAgents(roomsDir);
    expect(agents[0].urgencyThreshold).toBe(5);
    expect(agents[0].provider).toEqual({ name: "anthropic" });
  });
});
