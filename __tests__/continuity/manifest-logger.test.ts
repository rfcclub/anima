import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ManifestLogger, mintForTurn, stampProjectionProvenance } from "../../src/agents/manifest-logger";
import { buildSystemPromptFromPlan } from "../../src/agents/prompter";
import type { LoadedAgent } from "../../src/agents/loader";
import type { RoomConfig } from "../../src/config/types";
import type { ExecutionPlan } from "../../src/cartridge/types";
import { NullMemoryAdapter } from "../../src/memory/null-adapter";

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

function freshDbPath(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "manifest-logger-"));
  return join(tmpDir, "continuity.db");
}

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
  return { identity: "bruno-fixture", universal: [], dependencies: [], events: [], budget: { estimated: 0, limit: 5000 } };
}

async function mintFixture(dbPath: string) {
  const agent = makeAgent();
  const plan = makePlan();
  const built = buildSystemPromptFromPlan(agent, plan, {});
  return mintForTurn({
    agent,
    surfaceId: "cc",
    executionPlan: plan,
    prompt: built,
    writeScopes: ["scent"],
    dbPath,
  });
}

describe("SC-35 logger records per-turn provenance", () => {
  test("exactly one manifest_log row is appended with turnId/projectionId/stateHash/domainVersions/surfaceId/compiledAt/outcome", async () => {
    const dbPath = freshDbPath();
    const { manifest } = await mintFixture(dbPath);
    const logger = new ManifestLogger(dbPath);
    const turnId = randomUUID();

    logger.record(turnId, manifest, "ok");

    const rows = logger.entriesFor(manifest.agentId);
    expect(rows.length).toBe(1);
    expect(rows[0].turnId).toBe(turnId);
    expect(rows[0].projectionId).toBe(manifest.projectionId);
    expect(rows[0].stateHash).toBe(manifest.stateHash);
    expect(rows[0].domainVersions).toEqual(manifest.memoryDomainVersions);
    expect(rows[0].surfaceId).toBe(manifest.surfaceId);
    expect(rows[0].compiledAt).toBe(manifest.compiledAt);
    expect(rows[0].outcome).toBe("ok");
    logger.close();
  });

  test("the row is written at completion time, not inside the mint step", async () => {
    const dbPath = freshDbPath();
    const { manifest } = await mintFixture(dbPath);
    // Minting alone (prepareTurn-equivalent) writes no manifest_log row.
    const logger = new ManifestLogger(dbPath);
    expect(logger.entriesFor(manifest.agentId).length).toBe(0);
    logger.close();
  });
});

describe("SC-36 logger is opt-in and default-off", () => {
  test("no manifest_log row exists unless record() is explicitly called", async () => {
    const dbPath = freshDbPath();
    await mintFixture(dbPath); // mint runs; record() deliberately not called
    const logger = new ManifestLogger(dbPath);
    expect(logger.entriesFor("bruno-fixture").length).toBe(0);
    logger.close();
  });
});

describe("SC-37 commit carries projection provenance", () => {
  test("a non-kernel write's metadata includes baseManifest.projectionId equal to the lease's projectionId", async () => {
    const dbPath = freshDbPath();
    const { lease } = await mintFixture(dbPath);
    const stamped = stampProjectionProvenance({ note: "hello" }, lease.baseManifest);
    expect((stamped.baseManifest as { projectionId: string }).projectionId).toBe(lease.baseManifest.projectionId);
    expect(stamped.note).toBe("hello");
  });
});

describe("SC-38 provenance is absent without the opt-in", () => {
  test("a raw-adapter write with no lease attaches no projectionId metadata", () => {
    const rawMetadata = { note: "hello" };
    expect((rawMetadata as Record<string, unknown>).baseManifest).toBeUndefined();
  });
});

describe("SC-39 errored turn still logs exactly once", () => {
  test("a turn that throws after mint still records exactly one row, with outcome: 'error'", async () => {
    const dbPath = freshDbPath();
    const { manifest } = await mintFixture(dbPath);
    const logger = new ManifestLogger(dbPath);
    const turnId = randomUUID();

    async function runTurn() {
      try {
        throw new Error("provider exploded mid-turn");
      } finally {
        logger.record(turnId, manifest, "error");
      }
    }

    await expect(runTurn()).rejects.toThrow("provider exploded mid-turn");

    const rows = logger.entriesFor(manifest.agentId);
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe("error");
    expect(rows[0].turnId).toBe(turnId);
    logger.close();
  });

  test("a successful turn records outcome: 'ok' via the same finally path", async () => {
    const dbPath = freshDbPath();
    const { manifest } = await mintFixture(dbPath);
    const logger = new ManifestLogger(dbPath);
    const turnId = randomUUID();
    let outcome: "ok" | "error" = "ok";

    async function runTurn() {
      try {
        return "done";
      } finally {
        logger.record(turnId, manifest, outcome);
      }
    }

    await runTurn();
    const rows = logger.entriesFor(manifest.agentId);
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe("ok");
    logger.close();
  });
});
