import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MappedFilesystemAdapter } from "../../src/substrate/mapped-filesystem-adapter";

function makeMap(root: string) {
  return JSON.stringify({
    version: 1,
    agent_id: "test-agent",
    substrate_type: "test-substrate",
    root,
    required_scopes: ["identity_core", "current_state"],
    scopes: {
      identity_core: {
        description: "Identity",
        required: true,
        sources: [
          {
            type: "paths",
            paths: ["soul.md"],
            trust: "high",
            weight: 1.0,
            evidence_required: false,
          },
        ],
      },
      current_state: {
        description: "State",
        required: true,
        sources: [
          {
            type: "paths",
            paths: ["state/*.md"],
            trust: "medium",
            weight: 0.8,
            evidence_required: false,
          },
        ],
      },
      project_history: {
        description: "Projects",
        required: false,
        sources: [
          {
            type: "paths",
            paths: ["projects/**/*.md"],
            trust: "medium",
            weight: 0.8,
            evidence_required: true,
          },
        ],
      },
    },
  });
}

describe("MappedFilesystemAdapter", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "substrate-"));
    mkdirSync(join(tmp, "state"));
    mkdirSync(join(tmp, "projects", "anima"), { recursive: true });
    writeFileSync(join(tmp, "soul.md"), "# Identity\nI am Test.");
    writeFileSync(join(tmp, "state", "now.md"), "# State\nWorking.");
    writeFileSync(
      join(tmp, "projects", "anima", "design.md"),
      "---\nconfidence: 0.9\n---\n# Design"
    );
  });

  afterEach(() => {
    Bun.spawn(["rm", "-rf", tmp]);
  });

  test("parses map and exposes agent metadata", () => {
    const adapter = new MappedFilesystemAdapter(makeMap(tmp));
    expect(adapter.agentId).toBe("test-agent");
    expect(adapter.substrateType).toBe("test-substrate");
  });

  test("listScopes returns all scopes", () => {
    const adapter = new MappedFilesystemAdapter(makeMap(tmp));
    const scopes = adapter.listScopes().map((s) => s.name);
    expect(scopes).toEqual(["identity_core", "current_state", "project_history"]);
  });

  test("resolve returns files for a scope", () => {
    const adapter = new MappedFilesystemAdapter(makeMap(tmp));
    const resolved = adapter.resolve("identity_core");
    expect(resolved.files.length).toBe(1);
    expect(resolved.files[0].relativePath).toBe("soul.md");
  });

  test("resolve handles glob patterns", () => {
    const adapter = new MappedFilesystemAdapter(makeMap(tmp));
    const resolved = adapter.resolve("current_state");
    expect(resolved.files.length).toBe(1);
    expect(resolved.files[0].relativePath).toBe("state/now.md");
  });

  test("retrieve returns content and merges duplicate paths across scopes", async () => {
    const map = JSON.stringify({
      version: 1,
      agent_id: "test-agent",
      substrate_type: "test-substrate",
      root: tmp,
      required_scopes: ["identity_core", "current_state"],
      scopes: {
        identity_core: {
          description: "Identity",
          required: true,
          sources: [
            {
              type: "paths",
              paths: ["soul.md"],
              trust: "high",
              weight: 1.0,
            },
          ],
        },
        self_model: {
          description: "Self",
          required: false,
          sources: [
            {
              type: "paths",
              paths: ["soul.md"],
              trust: "medium",
              weight: 0.6,
            },
          ],
        },
      },
    });

    const adapter = new MappedFilesystemAdapter(map);
    const results = await adapter.retrieve({ scopes: ["identity_core", "self_model"] });
    expect(results.length).toBe(1);
    expect(results[0].scopesMatched).toContain("identity_core");
    expect(results[0].scopesMatched).toContain("self_model");
    expect(results[0].weight).toBe(1.0);
    expect(results[0].trust).toBe("high");
  });

  test("retrieve marks missing scope", async () => {
    const adapter = new MappedFilesystemAdapter(makeMap(tmp));
    const results = await adapter.retrieve({ scopes: ["unknown"] });
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("missing_scope");
  });

  test("retrieve filters by evidence when requireEvidence is true", async () => {
    const adapter = new MappedFilesystemAdapter(makeMap(tmp));
    const results = await adapter.retrieve({
      scopes: ["project_history"],
      requireEvidence: true,
    });
    expect(results.length).toBe(1);
    expect(results[0].evidence).toBeDefined();
    expect(results[0].evidence?.confidence).toBe(0.9);
  });

  test("validateMap passes for valid map", () => {
    const adapter = new MappedFilesystemAdapter(makeMap(tmp));
    const result = adapter.validateMap();
    expect(result.valid).toBe(true);
  });

  test("validateMap fails when identity_core missing", () => {
    const map = JSON.stringify({
      version: 1,
      agent_id: "test-agent",
      substrate_type: "test-substrate",
      root: tmp,
      required_scopes: ["current_state"],
      scopes: {
        current_state: {
          description: "State",
          required: true,
          sources: [
            {
              type: "paths",
              paths: ["state/*.md"],
              trust: "medium",
              weight: 0.8,
            },
          ],
        },
      },
    });

    const adapter = new MappedFilesystemAdapter(map);
    const result = adapter.validateMap();
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "missing_required_runtime_scope")).toBe(true);
  });
});
