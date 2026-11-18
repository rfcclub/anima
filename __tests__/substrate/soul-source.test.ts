import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MappedFilesystemAdapter } from "../../src/substrate/mapped-filesystem-adapter";

function makeSoulMap(root: string) {
  return JSON.stringify({
    version: 1,
    agent_id: "test-agent",
    substrate_type: "soul-test",
    root,
    required_scopes: ["identity_core", "values"],
    scopes: {
      identity_core: {
        description: "Identity",
        required: true,
        sources: [
          {
            type: "soul",
            paths: ["SOUL.md"],
            trust: "high",
            weight: 1.0,
            evidence_required: false,
          },
        ],
      },
    },
  });
}

test("soul source emits part files as scoped content", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "substrate-soul-"));
  writeFileSync(
    join(tmp, "SOUL.md"),
    [
      "# SOUL.md",
      "",
      "## Identity",
      "Name: Test Agent.",
      "",
      "## Core Truths",
      "- Help for real.",
    ].join("\n"),
  );

  try {
    const adapter = new MappedFilesystemAdapter(makeSoulMap(tmp));
    const resolved = adapter.resolve("identity_core");
    expect(resolved.files.length).toBe(2);

    const identity = resolved.files.find((f) => f.relativePath === "identity_core.md");
    const values = resolved.files.find((f) => f.relativePath === "values.md");
    expect(identity).toBeDefined();
    expect(values).toBeDefined();

    const results = await adapter.retrieve({ scopes: ["identity_core"] });
    expect(results.length).toBe(2);
    const identityResult = results.find((r) => r.relativePath === "identity_core.md");
    expect(identityResult?.content).toContain("Name: Test Agent.");
  } finally {
    await Bun.spawn(["rm", "-rf", tmp]).exited;
  }
});

test("soul source rejects absolute and traversal paths", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "substrate-soul-"));
  writeFileSync(join(tmp, "SOUL.md"), "# SOUL\n\n## Identity\nX\n");

  const map = JSON.stringify({
    version: 1,
    agent_id: "test-agent",
    substrate_type: "soul-test",
    root: tmp,
    required_scopes: ["identity_core"],
    scopes: {
      identity_core: {
        description: "Identity",
        required: true,
        sources: [
          { type: "soul", paths: ["/etc/passwd"], trust: "high", weight: 1.0 },
          { type: "soul", paths: ["../SOUL.md"], trust: "high", weight: 1.0 },
        ],
      },
    },
  });

  try {
    const adapter = new MappedFilesystemAdapter(map);
    const resolved = adapter.resolve("identity_core");
    expect(resolved.files.length).toBe(0);
  } finally {
    await Bun.spawn(["rm", "-rf", tmp]).exited;
  }
});
