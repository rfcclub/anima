/**
 * Canonical identity-projection contract.
 *
 * This module intentionally does not name ANIMA's RuntimeProjection directly:
 * the concrete shape currently lives in identity-runtime and importing it here
 * would reverse the canonical dependency direction. Implementations bind the
 * generic result to RuntimeProjection at their composition boundary.
 */

export type ProjectionMode = "plan" | "edit" | "auto";

export interface ProjectionCompileRequest {
  identity: string;
  surfaceId: string;
  mode: ProjectionMode;
  message: string;
  /** `null` preserves ANIMA's explicit no-pluggable-layer override. */
  cartridgeOverride?: string | null;
  task?: string;
  /** Host-supplied, read-only context that must be in the canonical projection. */
  hostContext?: string[];
}

/** Read-only canonical composition port; it never mints a lease or writes. */
export interface ProjectionCompiler<TProjection> {
  compile(request: ProjectionCompileRequest): Promise<TProjection>;
}

/** Fail closed rather than allowing an implementation to invent composition defaults. */
export function assertProjectionCompileRequest(input: ProjectionCompileRequest): ProjectionCompileRequest {
  if (!input.identity) throw new Error("identity is required");
  if (!input.surfaceId) throw new Error("surfaceId is required");
  if (!input.message) throw new Error("message is required");
  if (!(["plan", "edit", "auto"] as const).includes(input.mode)) throw new Error("mode is invalid");
  return input;
}
