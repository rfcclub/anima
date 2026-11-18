import type { IdentityRuntimeJoin } from "./contract/transport-types.ts";
import type { ProjectionCompileRequest } from "@anima/continuity-core";
import type { RuntimeProjection } from "./contract/runtime-projection.ts";

/** Minimal surface boundary: ANIMA can join but cannot receive the authority. */
export interface IdentityRuntimeJoinClient {
  join(input: { clientId: string; surfaceId: string; compile: ProjectionCompileRequest; projection: RuntimeProjection }): Promise<IdentityRuntimeJoin>;
}

export class ProjectionMismatchError extends Error {
  constructor() { super("IdentityRuntime projection differs from the canonical compiler result"); this.name = "ProjectionMismatchError"; }
}

export interface AnimaRuntimeJoinResult { projection: string; projectionId: string; stateHash: string; leaseId: string; expiresAt: number; }

/** Opt-in ANIMA surface bridge; it holds only the runtime-issued capability. */
export async function joinAnimaIdentityRuntime(
  client: IdentityRuntimeJoinClient,
  input: { clientId: string; surfaceId: string; compile: ProjectionCompileRequest; projection: RuntimeProjection },
): Promise<AnimaRuntimeJoinResult> {
  if (!input.clientId.startsWith("anima:")) throw new Error("identity runtime ANIMA client id is invalid");
  if (input.compile.surfaceId !== input.surfaceId) throw new Error("identity runtime compile surface does not match join surface");
  const joined = await client.join({ clientId: input.clientId, surfaceId: input.surfaceId, compile: input.compile, projection: input.projection });
  if (joined.projection !== input.projection.prompt) throw new ProjectionMismatchError();
  return { projection: joined.projection, projectionId: joined.projectionId, stateHash: joined.stateHash, leaseId: joined.leaseId, expiresAt: joined.expiresAt };
}
