import { test, expect } from "bun:test";
import { buildSharedIdentityText } from "./shared-identity";
import type { LoadedAgent } from "../agents/loader";
import type { SubstrateAdapter, RetrievalResult } from "../substrate/substrate-adapter";

function fakeAgent(overrides: Partial<LoadedAgent> = {}): LoadedAgent {
  return {
    name: "bruno",
    label: "Bruno",
    roomDir: "/tmp/bruno",
    config: {} as LoadedAgent["config"],
    geneContent: "gene",
    sessionContextFiles: [],
    additionalContent: [],
    memoryAdapter: {} as LoadedAgent["memoryAdapter"],
    soulContent: "## Identity Core\nMARKER_RAW_SOUL_CONTENT",
    ...overrides,
  } as LoadedAgent;
}

function fakeSubstrateAdapter(content: string): SubstrateAdapter {
  const result = (scope: string): RetrievalResult => ({
    id: scope,
    absolutePath: `/tmp/${scope}`,
    relativePath: scope,
    content,
    scopesMatched: [scope],
    sourceIds: [scope],
    requestedBy: ["test"],
    trust: "high",
    weight: 1,
    status: "ok",
  });
  return {
    agentId: "bruno",
    substrateType: "test",
    listScopes: () => [],
    hasScope: () => true,
    resolve: () => ({ scope: "current_state", content: "", trust: "high" }) as never,
    retrieve: async (request) => request.scopes.map((s) => result(s)),
    validateMap: () => ({ valid: true, diagnostics: [] }) as never,
  };
}

test("buildSharedIdentityText returns a substrate-synthesized current identity summary when available", async () => {
  const agent = fakeAgent({ substrateAdapter: fakeSubstrateAdapter("MARKER_CURRENT_STATE_TEXT") });
  const text = await buildSharedIdentityText(agent);
  expect(text).toBeDefined();
  expect(text).toContain("MARKER_CURRENT_STATE_TEXT");
});

test("buildSharedIdentityText falls back to raw soulContent with no substrateAdapter", async () => {
  const agent = fakeAgent({ substrateAdapter: undefined });
  const text = await buildSharedIdentityText(agent);
  expect(text).toBeDefined();
  expect(text).toContain("MARKER_RAW_SOUL_CONTENT");
});

test("buildSharedIdentityText falls back to raw soulContent when substrate retrieval fails", async () => {
  const throwingAdapter: SubstrateAdapter = {
    agentId: "bruno",
    substrateType: "test",
    listScopes: () => [],
    hasScope: () => true,
    resolve: () => { throw new Error("boom"); },
    retrieve: async () => { throw new Error("boom"); },
    validateMap: () => ({ valid: true, diagnostics: [] }) as never,
  };
  const agent = fakeAgent({ substrateAdapter: throwingAdapter });
  const text = await buildSharedIdentityText(agent);
  expect(text).toContain("MARKER_RAW_SOUL_CONTENT");
});

test("buildSharedIdentityText returns undefined for an agent with no soul content and no substrate", async () => {
  const agent = fakeAgent({ soulContent: undefined, substrateAdapter: undefined });
  const text = await buildSharedIdentityText(agent);
  expect(text).toBeUndefined();
});

test("buildSharedIdentityText preserves the full soul when substrate scopes are all empty (regression)", async () => {
  // A long axioms-style SOUL (~6900 chars, 9 axioms). AgentLoader
  // synthesizes a minimal substrate adapter when no substrate.map.yaml
  // exists — every scope resolves to empty content.
  // buildCurrentIdentitySummary still ran produceCurrentIdentitySummary with
  // an 800-token/char cap inherited from Town's own session.ts constant,
  // truncating the summary to ~813 characters — cut off midway through the
  // first axiom, never reaching the later ones at all. The 800
  // cap isn't wrong for Town's UI turn budget; it's simply far smaller
  // than this shared path's actual budget (MAX_SHARED_INPUT_TOKENS =
  // 12,000) and produces a WORSE result than just using the full soul
  // when there's no additional substrate content to weigh it against.
  const longSoul = `## I. First\n${"filler text ".repeat(1000)}\n## IX. Deep marker\nMARKER_DEEP_IN_SOUL_PAST_800_CHARS`;
  const emptyScopeAdapter = fakeSubstrateAdapter("");
  const agent = fakeAgent({ soulContent: longSoul, substrateAdapter: emptyScopeAdapter });
  const text = await buildSharedIdentityText(agent);
  expect(text).toContain("MARKER_DEEP_IN_SOUL_PAST_800_CHARS");
});

test("buildSharedIdentityText never imports cartridge or identity-runtime-lease machinery (SC-002)", async () => {
  // Sentinel: check the actual import statements only, not comments —
  // this module's own docstring explains what it deliberately avoids,
  // which would otherwise false-positive a naive whole-file text match.
  const src = await Bun.file(new URL("./shared-identity.ts", import.meta.url)).text();
  const importLines = src
    .split("\n")
    .filter((line) => /^import\b/.test(line.trim()))
    .join("\n");
  expect(importLines).not.toMatch(/cartridge/i);
  expect(importLines).not.toMatch(/execution/i);
  expect(importLines).not.toMatch(/anima-adapter|anima-projection-compiler/i);
});
