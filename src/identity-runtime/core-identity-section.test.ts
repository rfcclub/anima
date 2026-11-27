import { describe, expect, test } from "bun:test";
import {
  CORE_IDENTITY_HEADING,
  MAX_CORE_IDENTITY_CHARS,
  coreIdentitySection,
  withCoreIdentity,
} from "./core-identity-section";

describe("core identity section", () => {
  test("is bounded, self-contained and points at the on-demand loader", () => {
    const section = coreIdentitySection("abel");

    expect(section.startsWith(CORE_IDENTITY_HEADING)).toBe(true);
    expect(section.length).toBeLessThanOrEqual(MAX_CORE_IDENTITY_CHARS);
    expect(section).toContain("POST /identity-runtime/substrate-load/abel");
    expect(section).toContain("grantId");
    expect(section).toContain("stateHash");
    // It must never carry a real path of its own; virtual ids are the only names.
    expect(section).not.toMatch(/\/(?:home|Users|root)\//);
  });

  test("is prepended once, so compiling an already-composed projection does not duplicate it", () => {
    const once = withCoreIdentity("## Soul\n\nIdentity.", "abel");
    const twice = withCoreIdentity(once, "abel");

    expect(twice).toBe(once);
    expect(once.split(CORE_IDENTITY_HEADING).length - 1).toBe(1);
    expect(once).toContain("## Soul\n\nIdentity.");
  });
});
