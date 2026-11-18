import { test, expect, describe } from "bun:test";

describe("MemoryConfig — new fields parsing", () => {
  test("RED: loadRoomConfig parses crossSessionBootstrap when present", async () => {
    const { loadRoomConfig } = await import("../../src/config/types");
    const yaml = `
identity:
  name: test-agent
  label: Test Agent
provider:
  type: openai
policy:
  allowedRoots: ["/tmp"]
session:
  defaultMode: plan
boot:
  gene: /tmp/gene.md
  sessionContext:
    - path: /tmp/context.md
memory:
  crossSessionBootstrap: true
  recallScope: pin
`;
    const config = loadRoomConfig(yaml);
    expect(config.memory?.crossSessionBootstrap).toBe(true);
    expect(config.memory?.recallScope).toBe("pin");
  });

  test("RED: no memory config means memory is undefined", async () => {
    const { loadRoomConfig } = await import("../../src/config/types");
    const yaml = `
identity:
  name: default-agent
  label: Default Agent
provider:
  type: openai
policy:
  allowedRoots: ["/tmp"]
session:
  defaultMode: plan
boot:
  gene: /tmp/gene.md
  sessionContext:
    - path: /tmp/context.md
`;
    const config = loadRoomConfig(yaml);
    expect(config.memory).toBeUndefined();
  });

  test("RED: memory config with only recallScope still parses", async () => {
    const { loadRoomConfig } = await import("../../src/config/types");
    const yaml = `
identity:
  name: recall-agent
  label: Recall Agent
provider:
  type: openai
policy:
  allowedRoots: ["/tmp"]
session:
  defaultMode: plan
boot:
  gene: /tmp/gene.md
  sessionContext:
    - path: /tmp/context.md
memory:
  recallScope: none
`;
    const config = loadRoomConfig(yaml);
    expect(config.memory?.recallScope).toBe("none");
    expect(config.memory?.crossSessionBootstrap).toBeUndefined();
  });
});

describe("ToolPolicy enforce flag (enforce-tool-policy SC-10/11)", () => {
  const base = (extra: string) => `
identity:
  name: test-agent
  label: Test Agent
provider:
  type: openai
policy:
  allowedRoots: ["/tmp"]
${extra}
session:
  defaultMode: plan
boot:
  gene: /tmp/gene.md
  sessionContext:
    - path: /tmp/context.md
`;

  test("SC-10: enforce defaults to warn", async () => {
    const { loadRoomConfig } = await import("../../src/config/types");
    expect(loadRoomConfig(base("")).policy.enforce).toBe("warn");
  });

  test("SC-10: explicit values parse", async () => {
    const { loadRoomConfig } = await import("../../src/config/types");
    for (const v of ["off", "warn", "block"]) {
      expect(loadRoomConfig(base(`  enforce: ${v}`)).policy.enforce).toBe(v as "off" | "warn" | "block");
    }
  });

  test("SC-11: unknown value is rejected", async () => {
    const { loadRoomConfig } = await import("../../src/config/types");
    expect(() => loadRoomConfig(base("  enforce: strict"))).toThrow();
  });
});

describe("MemoryConfig — hindsight pilot fields", () => {
  test("RED: loadRoomConfig parses hindsightBank and hindsightTimeoutMs", async () => {
    const { loadRoomConfig } = await import("../../src/config/types");
    const yaml = `
identity:
  name: pilot-agent
  label: Pilot Agent
provider:
  type: openai
policy:
  allowedRoots: ["/tmp"]
session:
  defaultMode: plan
boot:
  gene: /tmp/gene.md
  sessionContext:
    - path: /tmp/context.md
memory:
  type: shared
  hindsightBank: anima-cleo-pilot
  hindsightTimeoutMs: 7000
  hindsightTopK: 3
`;
    const config = loadRoomConfig(yaml);
    expect(config.memory?.hindsightBank).toBe("anima-cleo-pilot");
    expect(config.memory?.hindsightTimeoutMs).toBe(7000);
    expect(config.memory?.hindsightTopK).toBe(3);
  });
});
