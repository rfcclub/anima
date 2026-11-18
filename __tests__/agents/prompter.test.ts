import { describe, test, expect } from "bun:test";
import { buildSystemPromptFromPlan } from "../../src/agents/prompter";
import type { LoadedAgent } from "../../src/agents/loader";
import type { RoomConfig } from "../../src/config/types";
import type { ExecutionPlan } from "../../src/cartridge/types";
import { NullMemoryAdapter } from "../../src/memory/null-adapter";

function makeAgent(): LoadedAgent {
  return {
    name: "bruno",
    label: "Bruno",
    roomDir: "/tmp/bruno",
    config: {
      identity: { name: "bruno", label: "Bruno" },
      provider: { type: "openai", model: "gpt-4o" },
      policy: { allowedRoots: [] },
      session: { defaultMode: "auto", autoModeOptIn: true, compactThreshold: 2000 },
      boot: { gene: "gene.md", sessionContext: [] },
    } as RoomConfig,
    geneContent: "Test instructions.",
    soulContent: "## Soul\n\nOld raw soul content.",
    sessionContextFiles: [],
    additionalContent: [],
    memoryAdapter: new NullMemoryAdapter(),
  };
}

function makePlan(): ExecutionPlan {
  return {
    universal: [],
    dependencies: [],
    events: [],
  };
}

describe("buildSystemPromptFromPlan", () => {
  test("uses currentIdentitySummary when provided", () => {
    const agent = makeAgent();
    const plan = makePlan();
    const summary = "## Identity Core\n\nHonest and curious.\n\n## Relationship Context\n\nCompanion to Owner.";
    const prompt = buildSystemPromptFromPlan(agent, plan, { currentIdentitySummary: summary });
    expect(prompt.full).toContain("Companion to Owner");
    expect(prompt.full).not.toContain("Old raw soul content");
  });

  test("falls back to raw soul when currentIdentitySummary is absent", () => {
    const agent = makeAgent();
    const plan = makePlan();
    const prompt = buildSystemPromptFromPlan(agent, plan, {});
    expect(prompt.full).toContain("Old raw soul content");
  });
});
