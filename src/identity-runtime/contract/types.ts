import type { MemoryScope } from "../../memory/contract.ts";

/**
 * The substrate-map vocabulary a cartridge may declare. This is deliberately
 * distinct from cartridge visibility (`shared`, `agent`, ...) and from
 * `MemoryScope`; ScopeMapper is the only conversion boundary.
 */
export const CANONICAL_SUBSTRATE_SCOPES = [
  "identity_core",
  "values",
  "self_model",
  "relationship",
  "episodic_memory",
  "scars",
  "project_history",
  "skills",
  "world_lore",
  "style_memory",
  "current_state",
  "open_threads",
] as const;

export type CanonicalSubstrateScope = (typeof CANONICAL_SUBSTRATE_SCOPES)[number];

export type ScopeDiagnosticCode =
  | "unknown_scope"
  | "undeclared_scope"
  | "ambiguous_scope"
  | "read_scope_not_granted";

export interface ScopeDiagnostic {
  code: ScopeDiagnosticCode;
  message: string;
}

export interface ScopeMappingRule {
  substrateScope: CanonicalSubstrateScope;
  memoryScopes: readonly MemoryScope[];
}

export interface ResolvedScope {
  ok: true;
  requestedScope: CanonicalSubstrateScope;
  memoryScopes: readonly MemoryScope[];
}

export interface RejectedScope {
  ok: false;
  requestedScope: string;
  diagnostic: ScopeDiagnostic;
}

export type ScopeResolution = ResolvedScope | RejectedScope;

/** The minimum capability-only request shape used at the runtime boundary. */
export interface IdentityRuntimeRecallRequest {
  query: string;
  substrateScope: string;
}

/** A recall response always carries the mapping decision, including rejection. */
export interface IdentityRuntimeRecallResponse<T> {
  resolution: ScopeResolution;
  results: readonly T[];
}
