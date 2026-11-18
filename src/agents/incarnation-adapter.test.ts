import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { buildSystemPromptFromPlan } from "./prompter";
import { join, defaultContinuityDbPath } from "./incarnation-adapter";
import type { LoadedAgent } from "./loader";
import type { RoomConfig } from "../config/types";
import type { ExecutionPlan } from "../cartridge/types";
import { NullMemoryAdapter } from "../memory/null-adapter";

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

function makeAgent(): LoadedAgent {
  return {
    name: "bruno-fixture",
    label: "Bruno",
    roomDir: "/tmp/bruno-fixture",
    config: {
      identity: { name: "bruno-fixture", label: "Bruno" },
      provider: { type: "openai", model: "gpt-4o" },
      policy: { allowedRoots: [] },
      session: { defaultMode: "auto", autoModeOptIn: true, compactThreshold: 2000 },
      boot: { gene: "gene.md", sessionContext: [] },
    } as RoomConfig,
    geneContent: "Test instructions.",
    soulContent: "## Soul\n\nFixture soul content.",
    sessionContextFiles: [],
    additionalContent: [],
    memoryAdapter: new NullMemoryAdapter(),
  };
}

function makePlan(): ExecutionPlan {
  return {
    identity: "bruno-fixture",
    universal: [],
    dependencies: [],
    events: [],
    budget: { estimated: 0, limit: 5000 },
  };
}

function freshDbPath(): string {
  tmpDir = mkdtempSync(joinPath(tmpdir(), "incarnation-adapter-"));
  return joinPath(tmpDir, "continuity.db");
}

describe("SC-03/SC-04 join() golden test", () => {
  test("join()'s returned prompt is byte-identical to buildSystemPromptFromPlan's output", async () => {
    const agent = makeAgent();
    const plan = makePlan();
    const built = buildSystemPromptFromPlan(agent, plan, {});

    const result = await join({
      agent,
      surfaceId: "cc",
      executionPlan: plan,
      prompt: built,
      writeScopes: ["scent", "decision"],
      dbPath: freshDbPath(),
    });

    expect(result.prompt.full).toBe(built.full);
    expect(result.prompt.staticPrefix).toBe(built.staticPrefix);
    expect(result.prompt.staticHash).toBe(built.staticHash);
  });

  test("join() returns a manifest and lease with both stateHash and projectionId present", async () => {
    const agent = makeAgent();
    const plan = makePlan();
    const built = buildSystemPromptFromPlan(agent, plan, {});

    const result = await join({
      agent,
      surfaceId: "cc",
      executionPlan: plan,
      prompt: built,
      writeScopes: ["scent"],
      dbPath: freshDbPath(),
    });

    expect(result.manifest.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.manifest.projectionId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.lease.leaseId).toBeTruthy();
    expect(result.lease.baseManifest.stateHash).toBe(result.manifest.stateHash);
    expect(result.lease.baseManifest.projectionId).toBe(result.manifest.projectionId);
  });

  test("locked scopes never leak into writeScopes even if passed in", async () => {
    const agent = makeAgent();
    const plan = makePlan();
    const built = buildSystemPromptFromPlan(agent, plan, {});

    const result = await join({
      agent,
      surfaceId: "cc",
      executionPlan: plan,
      prompt: built,
      writeScopes: ["scent", "identity", "heartwood"],
      dbPath: freshDbPath(),
    });

    expect(result.lease.writeScopes).toEqual(["scent"]);
  });
});

describe("defaultContinuityDbPath", () => {
  test("resolves beside the per-agent memory.db under ~/.anima/agents/<agent>/", () => {
    const path = defaultContinuityDbPath("bruno");
    expect(path).toContain("/.anima/agents/bruno/continuity.db");
  });
});
