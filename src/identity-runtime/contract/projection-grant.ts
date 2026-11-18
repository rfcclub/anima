import type { MemoryScope } from "../../memory/contract.ts";
import type { CanonicalSubstrateScope } from "./types.ts";

/**
 * ANIMA-owned, opaque authorization record for one compiled projection.
 * The record itself stays in ContinuityService storage; Incarnation receives
 * only the id and may narrow, never widen, its write scope for a client lease.
 * Read capability fields are optional at the type boundary so grants persisted
 * before recall was introduced can be represented and fail closed.
 */
export interface ProjectionGrant {
  grantId: string;
  identity: string;
  surfaceId: string;
  projectionId: string;
  stateHash: string;
  writeScopes: readonly MemoryScope[];
  readScopes?: readonly MemoryScope[];
  declaredSubstrateScopes?: readonly CanonicalSubstrateScope[];
  scopeDeclarationStatus?: "unimplemented" | "implemented" | "none";
  issuedAt: number;
  expiresAt: number;
}

export interface NarrowProjectionGrantInput {
  identity: string;
  surfaceId: string;
  requestedWriteScopes: readonly MemoryScope[];
  now: number;
}

export interface NarrowedProjectionGrant {
  grantId: string;
  writeScopes: MemoryScope[];
  readScopes: MemoryScope[];
  declaredSubstrateScopes: CanonicalSubstrateScope[];
  scopeDeclarationStatus: "unimplemented" | "implemented" | "none";
  expiresAt: number;
}

/** Validate an ANIMA-issued grant before minting a narrower client capability. */
export function narrowProjectionGrant(
  grant: ProjectionGrant,
  input: NarrowProjectionGrantInput,
): NarrowedProjectionGrant {
  if (grant.identity !== input.identity) {
    throw new Error("projection grant identity does not match runtime identity");
  }
  if (grant.surfaceId !== input.surfaceId) {
    throw new Error("projection grant surface does not match runtime surface");
  }
  if (input.now >= grant.expiresAt) {
    throw new Error("projection grant has expired");
  }
  if (input.requestedWriteScopes.some((scope) => !grant.writeScopes.includes(scope))) {
    throw new Error("projection grant does not allow requested write scopes");
  }
  return {
    grantId: grant.grantId,
    writeScopes: [...input.requestedWriteScopes],
    readScopes: [...(grant.readScopes ?? [])],
    declaredSubstrateScopes: [...(grant.declaredSubstrateScopes ?? [])],
    scopeDeclarationStatus: grant.scopeDeclarationStatus ?? "unimplemented",
    expiresAt: grant.expiresAt,
  };
}
