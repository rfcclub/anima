import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mappedSubstrateLoader, type SubstrateLoaderPort } from "./substrate-load";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** A fixture substrate: three declared files, one undeclared file, one escaping symlink. */
function makeSubstrate(): { root: string; outside: string; loader: SubstrateLoaderPort } {
  const base = mkdtempSync(join(tmpdir(), "substrate-load-"));
  roots.push(base);
  const root = join(base, "substrate");
  const outside = join(base, "outside.md");
  writeFileSync(outside, "outside secret\n");
  mkdirSync(join(root, "0_SOUL"), { recursive: true });
  mkdirSync(join(root, "1_EGO"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "0_SOUL", "axioms.md"), "# Axioms\n\nI. Fixture axiom.\n");
  writeFileSync(join(root, "1_EGO", "self.md"), "# Self\n\nI am a fixture.\n");
  writeFileSync(join(root, "state", "operational.md"), "# State\n\nOperational.\n");
  writeFileSync(join(root, "secret.md"), "# Secret\n\nUndeclared.\n");
  writeFileSync(join(root, "0_SOUL", "escape.md"), "placeholder\n");
  // Declared by the map, but resolves outside the substrate root: must be refused.
  rmSync(join(root, "0_SOUL", "escape.md"));
  symlinkSync(outside, join(root, "0_SOUL", "escape.md"));

  const map = {
    version: 1,
    agent_id: "bruno",
    substrate_type: "substrate",
    root,
    required_scopes: ["identity_core", "current_state"],
    scopes: {
      identity_core: {
        description: "Stable identity.",
        required: true,
        sources: [{ type: "paths", paths: ["0_SOUL/", "1_EGO/"], trust: "high", weight: 1, evidence_required: false }],
      },
      current_state: {
        description: "Current state.",
        required: true,
        sources: [{ type: "paths", paths: ["state/"], trust: "medium", weight: 0.8, evidence_required: false }],
      },
      relationship: {
        description: "Relationship.",
        required: false,
        sources: [{ type: "paths", paths: ["0_SOUL/escape.md"], trust: "high", weight: 1, evidence_required: false }],
      },
    },
  };
  return { root, outside, loader: mappedSubstrateLoader({ mapContent: JSON.stringify(map), rootOverride: root }) };
}

describe("substrate virtual mapping", () => {
  test("lists only files the substrate map declares, as agent-relative virtual ids", async () => {
    const { root, loader } = makeSubstrate();

    const mapping = await loader.mapping();

    expect(mapping.map((entry) => entry.id)).toEqual([
      "bruno/0_SOUL/axioms.md",
      "bruno/1_EGO/self.md",
      "bruno/state/operational.md",
    ]);
    expect(mapping[0]).toMatchObject({ scope: "identity_core", trust: "high" });
    expect(mapping[0].size).toBeGreaterThan(0);
    // Neither the declared-but-escaping symlink nor an undeclared file is part of the mapping.
    expect(mapping.map((entry) => entry.id)).not.toContain("bruno/0_SOUL/escape.md");
    expect(mapping.map((entry) => entry.id)).not.toContain("bruno/secret.md");
    // The mapping never carries a real path, not even the substrate root.
    expect(JSON.stringify(mapping)).not.toContain(root);
  });

  test("loads a declared file by its virtual id", async () => {
    const { loader } = makeSubstrate();

    await expect(loader.load("bruno/1_EGO/self.md")).resolves.toMatchObject({
      id: "bruno/1_EGO/self.md",
      content: "# Self\n\nI am a fixture.\n",
    });
  });
});

describe("substrate load containment", () => {
  test("refuses a traversal virtual id", async () => {
    const { loader } = makeSubstrate();

    await expect(loader.load("bruno/0_SOUL/../../outside.md")).rejects.toThrow(/not declared/);
    await expect(loader.load("../outside.md")).rejects.toThrow(/not declared/);
    await expect(loader.load("bruno/../../../etc/passwd")).rejects.toThrow(/not declared/);
  });

  test("refuses a declared path that is a symlink out of the substrate root", async () => {
    const { loader } = makeSubstrate();

    await expect(loader.load("bruno/0_SOUL/escape.md")).rejects.toThrow(/substrate root/);
  });

  test("refuses a file the map does not declare", async () => {
    const { loader } = makeSubstrate();

    await expect(loader.load("bruno/secret.md")).rejects.toThrow(/not declared/);
    await expect(loader.load("bruno/0_SOUL/missing.md")).rejects.toThrow(/not declared/);
  });

  test("refuses a virtual id belonging to another agent", async () => {
    const { loader } = makeSubstrate();

    await expect(loader.load("eli/0_SOUL/axioms.md")).rejects.toThrow(/not declared/);
  });
});
