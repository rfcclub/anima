import { describe, it, expect } from "bun:test";
import { NullMemoryAdapter } from "../../src/memory/null-adapter";
import { SharedMemoryAdapter } from "../../src/memory/shared-adapter";
import { AgentLoader } from "../../src/agents/loader";
import { join } from "node:path";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

describe("Memory Adapters", () => {
  describe("NullMemoryAdapter", () => {
    it("should return empty array on recall", async () => {
      const adapter = new NullMemoryAdapter();
      const results = await adapter.recall("test");
      expect(results).toEqual([]);
    });

    it("should no-op on store", async () => {
      const adapter = new NullMemoryAdapter();
      await expect(adapter.store({
        namespace: "test",
        content: "test",
        type: "fact",
        timestamp: new Date().toISOString()
      })).resolves.toBeUndefined();
    });
  });

  describe("SharedMemoryAdapter", () => {
    const dbPath = join(process.cwd(), "test-shared-memory.db");

    it("should store and recall memories", async () => {
      const adapter = new SharedMemoryAdapter(dbPath);
      const entry = {
        namespace: "test",
        content: "hello world",
        type: "fact" as const,
        timestamp: new Date().toISOString()
      };

      await adapter.store(entry);
      const results = await adapter.recall("hello");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toBe("hello world");

      adapter.close();
      rmSync(dbPath, { force: true });
    });
  });

  describe("AgentLoader Adapter Loading", () => {
    const roomsDir = join(process.cwd(), "test-rooms");

    it("should load correct adapter type", async () => {
      // Mock room config
      const agentName = "test-agent";
      const roomDir = join(roomsDir, agentName);
      mkdirSync(roomDir, { recursive: true });
      writeFileSync(join(roomDir, "PREFACE.md"), "soul");
      writeFileSync(join(roomDir, "AGENTS.md"), "session context");

      const loader = new AgentLoader({ roomsDir });

      // Test shared
      writeFileSync(join(roomDir, "config.yaml"), `
identity:
  name: ${agentName}
  label: Test
provider:
  type: gemini
policy:
  allowedRoots: []
session:
  defaultMode: plan
  compactThreshold: 1000
boot:
  gene: PREFACE.md
  soul: PREFACE.md
  sessionContext:
    - AGENTS.md
memory:
  type: shared
`);
      const agentShared = await loader.load(agentName);
      expect(agentShared.memoryAdapter).toBeInstanceOf(SharedMemoryAdapter);

      // Test custom
      writeFileSync(join(roomDir, "config.yaml"), `
identity:
  name: ${agentName}
  label: Test
provider:
  type: gemini
policy:
  allowedRoots: []
session:
  defaultMode: plan
  compactThreshold: 1000
boot:
  gene: PREFACE.md
  soul: PREFACE.md
  sessionContext:
    - AGENTS.md
memory:
  type: custom
  entityScript: test.mjs
`);
      const agentCustom = await loader.load(agentName);
      expect(agentCustom.memoryAdapter.constructor.name).toBe("CustomMemoryAdapter");

      rmSync(roomsDir, { recursive: true, force: true });
    });
  });
});
