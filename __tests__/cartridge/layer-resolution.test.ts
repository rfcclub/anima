import { describe, test, expect } from "bun:test";
import { CartridgeLoader } from "../../src/cartridge/loader";
import type { CartridgeKind, CartridgeBlock } from "../../src/cartridge/types";
import type { CartridgeEntry } from "../../src/cartridge/registry";
import type { PermissionMode } from "../../src/config/types";

function makeEntry(overrides: Partial<CartridgeEntry> & { name: string; kind: CartridgeKind }): CartridgeEntry {
  return {
    category: "craft",
    path: `/test/${overrides.name}.md`,
    content: `# ${overrides.name}`,
    scope: "shared",
    type: "cartridge",
    ...overrides,
  };
}

describe("per-layer scoring", () => {
  test("SC-001: language layer ignores role candidates", () => {
    const loader = new CartridgeLoader();
    const entries = [
      makeEntry({ name: "python", kind: "language", category: "craft", triggers: { task: ["python"] } }),
      makeEntry({ name: "reviewer", kind: "role", category: "craft", triggers: { task: ["review"] } }),
    ];

    const langResult = loader.resolveLayer("language", entries, {
      mode: "edit",
      message: "fix this python script",
    });

    expect(langResult.length).toBe(1);
    expect(langResult[0].entry.name).toBe("python");

    const roleResult = loader.resolveLayer("role", entries, {
      mode: "edit",
      message: "fix this python script",
    });
    expect(roleResult.length).toBe(0); // no role match for "fix this python script"
  });

  test("SC-002: no candidate in a layer resolves to empty", () => {
    const loader = new CartridgeLoader();
    const entries = [
      makeEntry({ name: "typescript", kind: "language" }),
    ];

    const result = loader.resolveLayer("framework", entries, {
      mode: "edit",
      message: "fix the bug",
    });

    expect(result.length).toBe(0);
  });

  test("SC-003: exact keyword beats same-kind sibling", () => {
    const loader = new CartridgeLoader();
    const entries = [
      makeEntry({ name: "python", kind: "language", triggers: { task: ["python"] } }),
      makeEntry({ name: "typescript", kind: "language", triggers: { task: ["typescript"] } }),
    ];

    const result = loader.resolveLayer("language", entries, {
      mode: "edit",
      message: "fix this python script",
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].entry.name).toBe("python");
  });

  test("SC-004: regression — csharp wins when keyword matches", () => {
    const loader = new CartridgeLoader();
    const entries = [
      makeEntry({ name: "typescript", kind: "language", triggers: { task: ["typescript"] } }),
      makeEntry({ name: "python", kind: "language", triggers: { task: ["python"] } }),
      makeEntry({ name: "csharp", kind: "language", triggers: { task: ["csharp"] } }),
    ];

    const result = loader.resolveLayer("language", entries, {
      mode: "edit",
      message: "fix the csharp code",
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].entry.name).toBe("csharp");
  });

  test("SC-005: selfSelect breaks a tie", () => {
    const loader = new CartridgeLoader();
    const entries = [
      makeEntry({ name: "programmer", kind: "role" }),
      makeEntry({ name: "architect", kind: "role" }),
    ];

    const result = loader.resolveLayer("role", entries, {
      mode: "edit",
      message: "hello",
      selfSelect: "architect",
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].entry.name).toBe("architect");
  });

  test("SC-006: strong trigger overrides selfSelect", () => {
    const loader = new CartridgeLoader();
    const entries = [
      makeEntry({ name: "architect", kind: "role" }),
      makeEntry({ name: "debugger", kind: "role", triggers: { task: ["debug"] } }),
    ];

    const result = loader.resolveLayer("role", entries, {
      mode: "edit",
      message: "debug this crash",
      selfSelect: "architect",
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].entry.name).toBe("debugger");
  });
});

describe("dependency graph expansion", () => {
  test("SC-012: programmer role loads its declared dependency", async () => {
    const loader = new CartridgeLoader();
    const entries = [
      makeEntry({ name: "programmer", kind: "role", requires: ["programming-kernel"] }),
      makeEntry({ name: "programming-kernel", kind: "kernel" }),
    ];

    const roleResult = loader.resolveLayer("role", entries, {
      mode: "edit",
      message: "hello",
      defaultRole: "programmer",
    });
    expect(roleResult.length).toBeGreaterThan(0);
    expect(roleResult[0].entry.name).toBe("programmer");

    // Expand dependencies
    const deps = loader.expandDependencies(roleResult[0].entry, entries);
    expect(deps.length).toBe(1);
    expect(deps[0].name).toBe("programming-kernel");
  });

  test("SC-013: creative-writer role loads no programming kernel", () => {
    const loader = new CartridgeLoader();
    const entries = [
      makeEntry({ name: "creative-writer", kind: "role", requires: [] }),
      makeEntry({ name: "programming-kernel", kind: "kernel" }),
    ];

    const roleResult = loader.resolveLayer("role", entries, {
      mode: "edit",
      message: "hello",
      defaultRole: "creative-writer",
    });
    expect(roleResult.length).toBeGreaterThan(0);

    const deps = loader.expandDependencies(roleResult[0].entry, entries);
    expect(deps.length).toBe(0);
  });

  test("SC-014: transitive dependency expansion", () => {
    const loader = new CartridgeLoader();
    const entries = [
      makeEntry({ name: "reviewer", kind: "role", requires: ["programming-kernel", "qa-review-common"] }),
      makeEntry({ name: "programming-kernel", kind: "kernel" }),
      makeEntry({ name: "qa-review-common", kind: "kernel", requires: ["qa-code"] }),
      makeEntry({ name: "qa-code", kind: "review" }),
    ];

    const roleResult = loader.resolveLayer("role", entries, {
      mode: "edit",
      message: "review this code",
      defaultRole: "reviewer",
    });
    expect(roleResult.length).toBeGreaterThan(0);

    const deps = loader.expandDependencies(roleResult[0].entry, entries);
    expect(deps.length).toBe(3);
    const depNames = deps.map(d => d.name);
    expect(depNames).toContain("programming-kernel");
    expect(depNames).toContain("qa-review-common");
    expect(depNames).toContain("qa-code");
  });

  test("SC-015: new role requires no resolver code change", () => {
    const loader = new CartridgeLoader();
    const entries = [
      makeEntry({ name: "security", kind: "role", requires: ["programming-kernel", "security-principles"] }),
      makeEntry({ name: "programming-kernel", kind: "kernel" }),
      makeEntry({ name: "security-principles", kind: "kernel" }),
    ];

    const roleResult = loader.resolveLayer("role", entries, {
      mode: "edit",
      message: "check security",
      defaultRole: "security",
    });
    expect(roleResult.length).toBeGreaterThan(0);

    const deps = loader.expandDependencies(roleResult[0].entry, entries);
    expect(deps.length).toBe(2);
    const depNames = deps.map(d => d.name);
    expect(depNames).toContain("programming-kernel");
    expect(depNames).toContain("security-principles");
  });
});

describe("Default Role / Working Role / identity", () => {
  test("SC-016: no-signal turn falls back to default role", () => {
    const loader = new CartridgeLoader();
    const entries = [
      makeEntry({ name: "programmer", kind: "role" }),
    ];

    const result = loader.resolveLayer("role", entries, {
      mode: "edit",
      message: "Hello",
      defaultRole: "programmer",
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].entry.name).toBe("programmer");
  });

  test("SC-017: strong-signal turn overrides default role", () => {
    const loader = new CartridgeLoader();
    const entries = [
      makeEntry({ name: "programmer", kind: "role" }),
      makeEntry({ name: "reviewer", kind: "role", triggers: { task: ["review"] } }),
    ];

    const result = loader.resolveLayer("role", entries, {
      mode: "edit",
      message: "review this diff",
      defaultRole: "programmer",
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].entry.name).toBe("reviewer");
  });
});

describe("persona resolution", () => {
  test("SC-021: companion persona coexists with non-conversational working role", () => {
    const loader = new CartridgeLoader();
    const entries = [
      makeEntry({ name: "warmth", kind: "persona" }),
      makeEntry({ name: "architect", kind: "role", triggers: { task: ["architect"] } }),
    ];

    const personaResult = loader.resolveLayer("persona", entries, {
      mode: "edit",
      message: "architect this system",
    });
    const roleResult = loader.resolveLayer("role", entries, {
      mode: "edit",
      message: "architect this system",
    });

    // Both should resolve independently
    expect(personaResult.length).toBeGreaterThan(0);
    expect(personaResult[0].entry.name).toBe("warmth");
    expect(roleResult.length).toBeGreaterThan(0);
    expect(roleResult[0].entry.name).toBe("architect");
  });
});
