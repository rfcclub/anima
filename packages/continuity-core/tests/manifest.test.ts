import { describe, test, expect } from "bun:test";
import { buildManifest, canonicalJson, type BuildManifestInput } from "../src/manifest";

function baseline(overrides: Partial<BuildManifestInput> = {}): BuildManifestInput {
  return {
    agentId: "bruno",
    kernelVersion: "sha-soul-gene",
    cartridgeVersions: { persona: "sha-persona", role: "sha-role" },
    substrateViewVersion: "sha-view",
    memoryDomainVersions: { identity: "0", private: "0", heartwood: "0" },
    surfaceId: "cc",
    compiledAt: 1000,
    promptStaticHash: "sha-prompt",
    ...overrides,
  };
}

describe("SC-08 manifest present and complete", () => {
  test("every manifest field is populated with a domain-version entry per locked scope", () => {
    const manifest = buildManifest(baseline());
    expect(manifest.agentId).toBe("bruno");
    expect(manifest.kernelVersion).toBe("sha-soul-gene");
    expect(manifest.cartridgeVersions).toEqual({ persona: "sha-persona", role: "sha-role" });
    expect(manifest.substrateViewVersion).toBe("sha-view");
    expect(manifest.memoryDomainVersions.identity).toBeDefined();
    expect(manifest.memoryDomainVersions.private).toBeDefined();
    expect(manifest.memoryDomainVersions.heartwood).toBeDefined();
    expect(manifest.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.projectionId).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("SC-09 empty memory yields sentinel domain versions", () => {
  test("no prior promotions for a scope reads as sentinel \"0\" and compiles fine", () => {
    const manifest = buildManifest(baseline({ memoryDomainVersions: { identity: "0", private: "0", heartwood: "0" } }));
    expect(manifest.memoryDomainVersions.identity).toBe("0");
    expect(manifest.stateHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("SC-10 same state, same hash, any surface/compile", () => {
  test("two different surfaces and two compiles from one surface yield identical stateHash", () => {
    const a = buildManifest(baseline({ surfaceId: "cc", compiledAt: 1 }));
    const b = buildManifest(baseline({ surfaceId: "anima", compiledAt: 2 }));
    const c = buildManifest(baseline({ surfaceId: "cc", compiledAt: 3 }));
    const d = buildManifest(baseline({ surfaceId: "cc", compiledAt: 1 }));
    expect(a.stateHash).toBe(b.stateHash);
    expect(a.stateHash).toBe(c.stateHash);
    expect(a.stateHash).toBe(d.stateHash);
  });
});

describe("SC-11 each state input perturbs the hash", () => {
  const baselineManifest = buildManifest(baseline());

  test("soul/gene content (kernelVersion) change perturbs stateHash", () => {
    const changed = buildManifest(baseline({ kernelVersion: "sha-soul-gene-v2" }));
    expect(changed.stateHash).not.toBe(baselineManifest.stateHash);
  });

  test("one cartridge block change perturbs stateHash", () => {
    const changed = buildManifest(baseline({ cartridgeVersions: { persona: "sha-persona-v2", role: "sha-role" } }));
    expect(changed.stateHash).not.toBe(baselineManifest.stateHash);
  });

  test("substrate view file set change perturbs stateHash", () => {
    const changed = buildManifest(baseline({ substrateViewVersion: "sha-view-v2" }));
    expect(changed.stateHash).not.toBe(baselineManifest.stateHash);
  });

  test("one locked-scope domain revision counter increment perturbs stateHash", () => {
    const changed = buildManifest(
      baseline({ memoryDomainVersions: { identity: "1", private: "0", heartwood: "0" } }),
    );
    expect(changed.stateHash).not.toBe(baselineManifest.stateHash);
  });
});

describe("SC-11b compile-occurrence inputs do not perturb stateHash", () => {
  test("surfaceId or compiledAt alone changes projectionId but not stateHash", () => {
    const a = buildManifest(baseline({ surfaceId: "cc", compiledAt: 1 }));
    const b = buildManifest(baseline({ surfaceId: "openclaw", compiledAt: 1 }));
    const c = buildManifest(baseline({ surfaceId: "cc", compiledAt: 42 }));

    expect(b.stateHash).toBe(a.stateHash);
    expect(c.stateHash).toBe(a.stateHash);
    expect(b.projectionId).not.toBe(a.projectionId);
    expect(c.projectionId).not.toBe(a.projectionId);
  });
});

describe("canonical-JSON key-order stability", () => {
  test("object key order does not change the hash", () => {
    const inOrder = buildManifest(
      baseline({ cartridgeVersions: { persona: "a", role: "b" } }),
    );
    const reordered = buildManifest(
      baseline({ cartridgeVersions: { role: "b", persona: "a" } }),
    );
    expect(inOrder.stateHash).toBe(reordered.stateHash);
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
});

describe("manifest is additive to prompt caching", () => {
  test("buildManifest takes no StructuredPrompt field and returns no prompt field — it is attached alongside, never replaces staticHash", () => {
    const manifest = buildManifest(baseline());
    expect((manifest as Record<string, unknown>).full).toBeUndefined();
    expect((manifest as Record<string, unknown>).staticPrefix).toBeUndefined();
    // promptStaticHash is cross-reference only, distinct from the prompt's own staticHash field name.
    expect(manifest.promptStaticHash).toBe("sha-prompt");
  });
});
