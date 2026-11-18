import type { ProjectionCompileRequest } from "@anima/continuity-core";
import type { RuntimeProjection } from "./runtime-projection.ts";

export interface IdentityRuntimeJoin {
  projection: string;
  projectionId: string;
  stateHash: string;
  leaseId: string;
  expiresAt: number;
}

export interface IdentityRuntimeCompileJoin {
  clientId: string;
  surfaceId: string;
  compile: ProjectionCompileRequest;
  /** Omit only for a legacy runtime-owned composition caller during migration. */
  projection?: RuntimeProjection;
}
