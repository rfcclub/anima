import { describe, expect, test } from "bun:test";
import {
  narrowProjectionGrant,
  type ProjectionGrant,
} from "../../../src/identity-runtime/contract/projection-grant.ts";

const grant: ProjectionGrant = {
  grantId: "grant-1",
  identity: "eli",
  surfaceId: "windows-codex",
  projectionId: "projection-1",
  stateHash: "state-1",
  writeScopes: ["scent", "decision"],
  readScopes: ["episode", "observation"],
  declaredSubstrateScopes: ["episodic_memory"],
  scopeDeclarationStatus: "implemented",
  issuedAt: 1_000,
  expiresAt: 2_000,
};

describe("ProjectionGrant", () => {
  test("narrows write scopes without widening the ANIMA grant", () => {
    expect(narrowProjectionGrant(grant, {
      identity: "eli",
      surfaceId: "windows-codex",
      requestedWriteScopes: ["scent"],
      now: 1_500,
    })).toEqual({
      grantId: "grant-1",
      writeScopes: ["scent"],
      readScopes: ["episode", "observation"],
      declaredSubstrateScopes: ["episodic_memory"],
      scopeDeclarationStatus: "implemented",
      expiresAt: 2_000,
    });
  });

  test("rejects a client attempt to widen scope, cross identity, or use an expired grant", () => {
    expect(() => narrowProjectionGrant(grant, {
      identity: "eli",
      surfaceId: "windows-codex",
      requestedWriteScopes: ["scent", "identity"],
      now: 1_500,
    })).toThrow("projection grant does not allow requested write scopes");

    expect(() => narrowProjectionGrant(grant, {
      identity: "bruno",
      surfaceId: "windows-codex",
      requestedWriteScopes: ["scent"],
      now: 1_500,
    })).toThrow("projection grant identity does not match runtime identity");

    expect(() => narrowProjectionGrant(grant, {
      identity: "eli",
      surfaceId: "windows-codex",
      requestedWriteScopes: ["scent"],
      now: 2_000,
    })).toThrow("projection grant has expired");
  });
});
