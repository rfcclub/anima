import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ProjectionCompileRequest } from "@anima/continuity-core";
import type { RoomConfig } from "../config/types";
import type { LoadedAgent } from "../agents/loader";
import { NullMemoryAdapter } from "../memory/null-adapter";
import type { SubstrateAdapter } from "../substrate/substrate-adapter";
import type { SubstrateViewLayer } from "../substrate/substrate-view";
import {
  AnimaProjectionCompiler,
  createAnimaProjectionCompiler,
  type AnimaProjectionCompilerOptions,
} from "./anima-projection-compiler";

const config: RoomConfig = {
  identity: {
    name: "eli",
    label: "Eli",
    identityAnchor: "Eli remains Eli.",
  },
  provider: { type: "test", model: "test-model" },
  policy: { allowedRoots: [] },
  session: { defaultMode: "auto", autoModeOptIn: false, compactThreshold: 2_000 },
  boot: { gene: "AGENTS.md", soul: "SOUL.md", sessionContext: [] },
};

const agent: LoadedAgent = {
  name: "eli",
  label: "Eli",
  roomDir: "/fixture/eli",
  config,
  geneContent: "Keep changes small and evidence-based.",
  soulContent: "## Identity Core\n\nEli is a careful coding companion.",
  sessionContextFiles: [],
  additionalContent: [],
  memoryAdapter: new NullMemoryAdapter(),
};

const request: ProjectionCompileRequest = {
  identity: "eli",
  surfaceId: "windows-codex",
  mode: "auto",
  message: "Explain the active runtime boundary.",
};

const substrateAdapter: SubstrateAdapter = {
  agentId: "eli", substrateType: "fixture", listScopes: () => [], hasScope: () => false,
  resolve: (name) => ({ name, description: "", required: false, files: [] }),
  retrieve: async () => [], validateMap: () => ({ valid: true, diagnostics: [] }),
};
const substrateViewLayer: SubstrateViewLayer = {
  buildView: async () => ({
    turnContext: { agentId: "eli", runtimeRequiredScopes: [], agentDefaults: { agentId: "eli" }, cartridgePolicies: [], unifiedScopes: [], requireEvidence: false },
    results: [], estimatedTokens: 0, scopesCovered: [], scopesMissing: [], scopesEmpty: [], warnings: [],
  }),
};

describe("createAnimaProjectionCompiler", () => {
  test("preserves direct compiler output for the same Eli input", async () => {
    const options: AnimaProjectionCompilerOptions = { agent: { ...agent, substrateAdapter, substrateViewLayer } };

    const legacy = await new AnimaProjectionCompiler(options).compile(request);
    const extracted = await createAnimaProjectionCompiler(options).compile(request);

    expect(extracted).toEqual(legacy);
  });

  test("fails closed rather than emitting a partial projection without the substrate pair", async () => {
    const incomplete = {
      ...agent,
      substrateAdapter,
      substrateViewLayer: undefined,
    };

    await expect(createAnimaProjectionCompiler({ agent: incomplete }).compile(request))
      .rejects.toThrow("substrate adapter and view layer must be configured together");
  });

  test("SC-022: compile() output is unaffected by the core-identity-immediate-compiler change", async () => {
    const options: AnimaProjectionCompilerOptions = { agent: { ...agent, substrateAdapter, substrateViewLayer } };

    const projection = await new AnimaProjectionCompiler(options).compile(request);

    // AnimaProjectionCompiler itself was not touched by core-identity-compiler.ts /
    // core-identity-watcher.ts / the eli-continuity-service.ts compileProjection
    // cut-over — this asserts its own composition (identityEngine tiering the
    // fixture soulContent) still runs exactly as before that change.
    expect(projection.prompt).toContain("Eli is a careful coding companion");
    expect(projection.kernelVersion).toBe(
      createHash("sha256").update(`${agent.soulContent}\n${agent.geneContent}`).digest("hex"),
    );
  });

  test("reports bounded substrate truncation metadata (scopes, counts, budget) in the projection", async () => {
    const big = (n: number) => "x".repeat(n * 4);
    const result = (id: string, scope: string, n: number) => ({
      id, absolutePath: `/fixture/${id}.md`, relativePath: `${id}.md`, content: big(n), scopesMatched: [scope],
      sourceIds: [`${scope}:0`], requestedBy: [], trust: "high" as const, weight: 1, status: "ok" as const,
    });
    const layer: SubstrateViewLayer = {
      buildView: async () => ({
        turnContext: { agentId: "eli", runtimeRequiredScopes: [], agentDefaults: { agentId: "eli" }, cartridgePolicies: [], unifiedScopes: [], requireEvidence: false },
        results: [result("a", "identity_core", 100), result("b", "values", 900)],
        estimatedTokens: 0, scopesCovered: [], scopesMissing: [], scopesEmpty: [], warnings: [],
      }),
    };
    const tight = { ...agent, config: { ...config, session: { ...config.session, substrateViewMaxTokens: 300 } }, substrateAdapter, substrateViewLayer: layer };

    const projection = await new AnimaProjectionCompiler({ agent: tight }).compile(request);

    expect(projection.substrateTruncation).toEqual({ budgetTokens: 300, droppedScopes: ["values"], droppedBlocks: 1 });
    expect(JSON.stringify(projection.substrateTruncation)).not.toContain("xxxx");
  });

  test("reports no truncation metadata when the substrate view fits", async () => {
    const projection = await new AnimaProjectionCompiler({ agent: { ...agent, substrateAdapter, substrateViewLayer } }).compile(request);
    expect(projection.substrateTruncation).toBeUndefined();
  });
});
