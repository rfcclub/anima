import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MappedFilesystemAdapter } from "../../src/substrate/mapped-filesystem-adapter";
import { DefaultSubstrateViewLayer } from "../../src/substrate/default-view-layer";

function makeMap(root: string) {
  return JSON.stringify({
    version: 1,
    agent_id: "test-agent",
    substrate_type: "test",
    root,
    required_scopes: ["identity_core", "current_state"],
    scopes: {
      identity_core: {
        description: "Identity",
        required: true,
        sources: [{ type: "paths", paths: ["soul.md"], trust: "high", weight: 1.0 }],
      },
      current_state: {
        description: "State",
        required: true,
        sources: [{ type: "paths", paths: ["state/*.md"], trust: "medium", weight: 0.8 }],
      },
      values: {
        description: "Values",
        required: false,
        sources: [{ type: "soul", paths: ["SOUL.md"], trust: "high", weight: 1.0 }],
      },
    },
  });
}

test("DefaultSubstrateViewLayer builds view from adapter", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "svl-"));
  const stateDir = join(tmp, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(tmp, "soul.md"), "# Identity\nI am Test.");
  writeFileSync(join(stateDir, "now.md"), "# State\nWorking.");
  try {
    const adapter = new MappedFilesystemAdapter(makeMap(tmp));
    const layer = new DefaultSubstrateViewLayer();
    const view = await layer.buildView({
      adapter,
      agentDefaults: { agentId: "test-agent", defaultScopes: ["values"] },
      cartridgePolicies: [],
    });

    expect(view.turnContext.unifiedScopes).toContain("identity_core");
    expect(view.turnContext.unifiedScopes).toContain("current_state");
    expect(view.turnContext.unifiedScopes).toContain("values");
    expect(view.scopesCovered).toContain("identity_core");
    expect(view.results.some((r) => r.content.includes("I am Test."))).toBe(true);
  } finally {
    await Bun.spawn(["rm", "-rf", tmp]).exited;
  }
});

test("soul parts appear as separate scopes", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "svl-soul-"));
  writeFileSync(
    join(tmp, "SOUL.md"),
    ["# SOUL", "", "## Identity", "Name: Soul.", "", "## Core Truths", "- Truth."].join("\n"),
  );

  try {
    const adapter = new MappedFilesystemAdapter(makeMap(tmp));
    const layer = new DefaultSubstrateViewLayer();
    const view = await layer.buildView({
      adapter,
      agentDefaults: { agentId: "test-agent", defaultScopes: ["values"] },
      cartridgePolicies: [],
    });

    const valuesResult = view.results.find((r) => r.relativePath === "values.md");
    expect(valuesResult).toBeDefined();
    expect(valuesResult?.content).toContain("- Truth.");
  } finally {
    await Bun.spawn(["rm", "-rf", tmp]).exited;
  }
});
