import { createHash } from "node:crypto";
import type {
  RemoteCompileResult,
  RemoteContinuityPort,
} from "../../../src/identity-runtime/contract/remote-continuity.ts";

/**
 * Marker used everywhere a compiled identity would carry a real version. A service tenant never
 * claims a kernel or a substrate view, so these values are honestly self-describing rather than
 * plausible-looking fakes.
 */
export const SERVICE_STATIC_MARKER = "service-static";

const SERVICE_GRANT_TTL_MS = 30 * 60 * 1000;

/**
 * A non-model service installation's continuity port.
 *
 * Every method throws. There is deliberately no stub that returns an empty-but-valid projection:
 * if any caller reaches compile, remember or recall through a service tenant, the failure is loud
 * and cannot be mistaken for a successful model-agent admission.
 */
export class StaticServiceContinuity implements RemoteContinuityPort {
  constructor(readonly tenantId: string) {}

  async compile(): Promise<never> {
    throw new Error("service tenants are not compiled");
  }

  async remember(): Promise<never> {
    throw new Error("service tenants have no memory");
  }

  async recall(): Promise<never> {
    throw new Error("service tenants have no recall");
  }
}

/** Deterministic projection state hash: same tenant and surface always produce the same value. */
export function serviceStateHash(tenantId: string, surfaceId: string): string {
  return createHash("sha256").update(`service|${tenantId}|${surfaceId}`).digest("hex");
}

/**
 * The projection and grant a service tenant receives instead of a compiled identity.
 *
 * Scopes are empty by construction: a service receives Mesh admission and nothing else. The grant
 * still flows through `narrowProjectionGrant()`, so the lease's narrowing invariant is preserved
 * rather than special-cased.
 */
export function staticJoinResult(tenantId: string, surfaceId: string, now: number): RemoteCompileResult {
  return {
    projection: {
      prompt: "",
      promptStaticHash: "",
      kernelVersion: SERVICE_STATIC_MARKER,
      cartridgeVersions: {},
      substrateViewVersion: SERVICE_STATIC_MARKER,
      readScopes: [],
      writeScopes: [],
      proposalScopes: [],
      declaredSubstrateScopes: [],
      scopeDeclarationStatus: "none",
    },
    grant: {
      grantId: `service:${tenantId}:${surfaceId}`,
      identity: tenantId,
      surfaceId,
      projectionId: `${SERVICE_STATIC_MARKER}:${tenantId}`,
      stateHash: serviceStateHash(tenantId, surfaceId),
      writeScopes: [],
      readScopes: [],
      issuedAt: now,
      expiresAt: now + SERVICE_GRANT_TTL_MS,
    },
  };
}
