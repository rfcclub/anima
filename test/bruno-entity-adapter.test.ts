import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import {
  BrunoEntityAdapter,
  type ExecFn,
  type ExecResult,
} from "../src/memory/bruno-entity-adapter";
import type { AgentMemoryEntry } from "../src/memory/contract";
import { MemoryWriteError } from "../src/memory/errors";

// ── Mock exec function ───────────────────────────────────────────────────────

type ExecHandler = (cmd: string[], opts?: { env?: Record<string, string> }) => ExecResult;

let execHandler: ExecHandler;

const mockExec: ExecFn = async (
  cmd: string[],
  opts?: { env?: Record<string, string> },
): Promise<ExecResult> => {
  return execHandler(cmd, opts);
};

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SAMPLE_RECALL_OUTPUT = JSON.stringify({
  query: "test query",
  confidence: "high",
  neurons: [
    {
      id: "n-001",
      content: "Bruno and Owner worked on the ANIMA project architecture.",
      type: "episode",
      activation: 0.92,
    },
    {
      id: "n-002",
      content: "A preference for direct, honest communication.",
      type: "preference",
      activation: 0.78,
    },
    {
      id: "n-003",
      content: "Observation about drift detection heuristics.",
      type: "observation",
      activation: 0.45,
    },
  ],
  recalledIds: ["n-001", "n-002", "n-003"],
  paths: [],
});

const MEDIUM_CONFIDENCE_OUTPUT = JSON.stringify({
  query: "vague query",
  confidence: "medium",
  neurons: [
    {
      id: "n-004",
      content: "Something vaguely related.",
      type: "fact",
      activation: 0.3,
    },
  ],
  recalledIds: ["n-004"],
  paths: [],
});

const LOW_CONFIDENCE_OUTPUT = JSON.stringify({
  query: "obscure",
  confidence: "low",
  neurons: [
    {
      id: "n-005",
      content: "Obscure fact from long ago.",
      type: "fact",
      activation: 0.1,
    },
  ],
  recalledIds: ["n-005"],
  paths: [],
});

const EMPTY_RECALL_OUTPUT = JSON.stringify({
  query: "nothing",
  confidence: "low",
  neurons: [],
  recalledIds: [],
  paths: [],
});

// ── Setup ────────────────────────────────────────────────────────────────────

let adapter: BrunoEntityAdapter;

beforeEach(() => {
  execHandler = () => ({ stdout: "", stderr: "", exitCode: 0 });
  adapter = new BrunoEntityAdapter({
    recallScript: "/tmp/fake-recall.mjs",
    inboxWriterScript: "/tmp/fake-inbox.py",
    execFn: mockExec,
    agentName: "bruno",
  });
});

// ── Helper ───────────────────────────────────────────────────────────────────

function makeEntry(
  overrides: Partial<Omit<AgentMemoryEntry, "id" | "createdAt">> = {},
): Omit<AgentMemoryEntry, "id" | "createdAt"> {
  return {
    content: overrides.content ?? "test observation",
    scope: overrides.scope ?? "observation" as any,
    tags: overrides.tags ?? ["test"],
    confidence: overrides.confidence ?? 0.8,
    source: overrides.source ?? "bruno",
    ...overrides,
  };
}

// ── Tests: recall ────────────────────────────────────────────────────────────

describe("BrunoEntityAdapter.recall", () => {
  test("returns parsed neurons from recall.mjs output", async () => {
    execHandler = () => ({
      stdout: SAMPLE_RECALL_OUTPUT,
      stderr: "",
      exitCode: 0,
    });

    const results = await adapter.recall("test query");

    expect(results).toHaveLength(3);
    expect(results[0].id).toBe("n-001");
    expect(results[0].content).toContain("ANIMA project");
    expect(results[0].confidence).toBe(0.92); // Q1: per-neuron activation, not the whole-response label
    expect(results[0].metadata?.activation).toBe(0.92);
  });

  test("returns empty array when script exits non-zero", async () => {
    execHandler = () => ({
      stdout: "",
      stderr: "command not found",
      exitCode: 127,
    });

    const results = await adapter.recall("anything");
    expect(results).toEqual([]);
  });

  test("returns empty array for empty query", async () => {
    const results = await adapter.recall("");
    expect(results).toEqual([]);

    const results2 = await adapter.recall("   ");
    expect(results2).toEqual([]);
  });

  test("respects topK option", async () => {
    execHandler = () => ({
      stdout: SAMPLE_RECALL_OUTPUT,
      stderr: "",
      exitCode: 0,
    });

    const results = await adapter.recall("test query", { topK: 2 });
    expect(results).toHaveLength(2);
  });

  test("filters by minConfidence — now a genuine per-neuron cut, not a whole-response label", async () => {
    // SAMPLE_RECALL_OUTPUT neurons have activations 0.92, 0.78, 0.45 — a 0.8
    // threshold now keeps only the first, where the old whole-response "high"
    // label would have kept (and wrongly trusted) all three equally.
    execHandler = () => ({
      stdout: SAMPLE_RECALL_OUTPUT,
      stderr: "",
      exitCode: 0,
    });
    const highResults = await adapter.recall("test query", { minConfidence: 0.8 });
    expect(highResults.map((r) => r.id)).toEqual(["n-001"]);

    // Second recall: activation 0.3 — filtered out by 0.8 threshold
    execHandler = () => ({
      stdout: MEDIUM_CONFIDENCE_OUTPUT,
      stderr: "",
      exitCode: 0,
    });
    const medResults = await adapter.recall("vague query", { minConfidence: 0.8 });
    expect(medResults).toHaveLength(0);

    // Third recall: activation 0.1 — filtered out
    execHandler = () => ({
      stdout: LOW_CONFIDENCE_OUTPUT,
      stderr: "",
      exitCode: 0,
    });
    const lowResults = await adapter.recall("obscure", { minConfidence: 0.5 });
    expect(lowResults).toHaveLength(0);
  });

  test("confidence comes from each neuron's own activation", async () => {
    execHandler = () => ({
      stdout: MEDIUM_CONFIDENCE_OUTPUT,
      stderr: "",
      exitCode: 0,
    });

    const results = await adapter.recall("vague query");
    expect(results[0].confidence).toBe(0.3); // Q1: activation, not the "medium" → 0.6 bucket
  });

  test("handles empty neurons gracefully", async () => {
    execHandler = () => ({
      stdout: EMPTY_RECALL_OUTPUT,
      stderr: "",
      exitCode: 0,
    });

    const results = await adapter.recall("nothing");
    expect(results).toEqual([]);
  });

  test("handles invalid JSON from script", async () => {
    execHandler = () => ({
      stdout: "not valid json",
      stderr: "",
      exitCode: 0,
    });

    const results = await adapter.recall("anything");
    expect(results).toEqual([]);
  });
});

// ── Tests: remember ──────────────────────────────────────────────────────────

describe("BrunoEntityAdapter.remember", () => {
  test("writes via inbox_writer.py and returns entry", async () => {
    let capturedArgs: string[] = [];
    execHandler = (cmd) => {
      capturedArgs = cmd;
      return { stdout: "wrote: observation_test.json", stderr: "", exitCode: 0 };
    };

    const entry = makeEntry({
      content: "Test observation about the project.",
      tags: ["arch", "memory"],
    });

    const result = await adapter.remember(entry);

    expect(result.id).toBeTruthy();
    expect(result.content).toBe(entry.content);
    expect(result.scope).toBe("observation");
    expect(result.source).toBe("bruno");

    // Verify inbox_writer.py was called with correct args
    expect(capturedArgs[0]).toBe("python3");
    expect(capturedArgs[2]).toBe("--type");
    expect(capturedArgs[3]).toBe("OBSERVATION");
    expect(capturedArgs[5]).toBe("Test observation about the project.");

    // --tags goes as a flag with its values after it. An end-of-options "--"
    // in front (the original form) made argparse treat "--tags" itself as a
    // positional and exit 2 — every tagged remember wrote nothing, and the
    // failure was swallowed (the runtime recorded a
    // completed mutation for a memory that never landed).
    const tagsIdx = capturedArgs.indexOf("--tags");
    expect(tagsIdx).not.toBe(-1);
    expect(capturedArgs).not.toContain("--");
    expect(capturedArgs.slice(tagsIdx + 1)).toEqual(["arch", "memory"]);
  });

  test("rejects tag value starting with '-' (argument injection prevention)", async () => {
    execHandler = () => ({ stdout: "", stderr: "", exitCode: 0 });

    const entry = makeEntry({
      content: "injection attempt",
      tags: ["--inject-arg", "legit-tag"],
    });

    await expect(adapter.remember(entry)).rejects.toThrow(
      "Tag value rejected",
    );
  });

  test("maps scope to inbox type correctly", async () => {
    execHandler = () => ({ stdout: "", stderr: "", exitCode: 0 });

    const episodeResult = await adapter.remember(
      makeEntry({ content: "episode test", scope: "episode" as any }),
    );
    expect(episodeResult.scope).toBe("episode");

    const factResult = await adapter.remember(
      makeEntry({ content: "fact test", scope: "fact" as any }),
    );
    expect(factResult.scope).toBe("fact");
  });

  test("rejects with MemoryWriteError when inbox_writer exits non-zero", async () => {
    execHandler = () => ({
      stdout: "",
      stderr: "some python error",
      exitCode: 1,
    });

    await expect(
      adapter.remember(makeEntry({ content: "This should not silently succeed." })),
    ).rejects.toThrow(MemoryWriteError);
  });

  test("rejects with MemoryWriteError when execFn throws", async () => {
    execHandler = () => {
      throw new Error("spawn ENOENT");
    };

    await expect(
      adapter.remember(makeEntry({ content: "This should not silently succeed either." })),
    ).rejects.toThrow(MemoryWriteError);
  });
});

// ── Tests: bootstrap ─────────────────────────────────────────────────────────

describe("BrunoEntityAdapter.bootstrap", () => {
  test("returns recent neurons for broad query", async () => {
    execHandler = () => ({
      stdout: SAMPLE_RECALL_OUTPUT,
      stderr: "",
      exitCode: 0,
    });

    const results = await adapter.bootstrap();

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("n-001");
  });

  test("respects maxEntries option", async () => {
    execHandler = () => ({
      stdout: SAMPLE_RECALL_OUTPUT,
      stderr: "",
      exitCode: 0,
    });

    const results = await adapter.bootstrap({ maxEntries: 2 });
    expect(results).toHaveLength(2);
  });

  test("passes currentPrompt to recall if provided", async () => {
    let capturedQuery = "";
    execHandler = (cmd) => {
      const queryIdx = cmd.indexOf("--query");
      if (queryIdx !== -1) capturedQuery = cmd[queryIdx + 1];
      return { stdout: SAMPLE_RECALL_OUTPUT, stderr: "", exitCode: 0 };
    };

    await adapter.bootstrap({ currentPrompt: "What did we work on last time?" });
    expect(capturedQuery).toContain("What did we work on last time?");
  });

  test("returns empty array on exec failure", async () => {
    execHandler = () => ({
      stdout: "",
      stderr: "script crashed",
      exitCode: 1,
    });

    const results = await adapter.bootstrap();
    expect(results).toEqual([]);
  });
});
