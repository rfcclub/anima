import type { MemoryScope } from "../memory/contract";
import type { CartridgeCategory } from "./loader";
import type { CanonicalSubstrateScope } from "../identity-runtime/contract/scope-mapper.ts";

export const CARTRIDGE_KINDS = ["kernel", "persona", "role", "language", "framework", "project", "review", "task"] as const;
export type CartridgeKind = (typeof CARTRIDGE_KINDS)[number];

export interface CartridgeMemoryPolicy {
  writeScopes: MemoryScope[];
}

/** Per-cartridge retrieval policy — declares what substrate to query when this cartridge is active. */
export interface RetrievalPolicy {
  /** Legacy direct-memory declaration used by the pre-runtime retrieval plan. */
  scopes?: MemoryScope[];
  /** Phase-1 declaration consumed only through IdentityRuntime's ScopeMapper. */
  substrate_scopes?: CanonicalSubstrateScope[];
  top_k?: number;
  max_tokens?: number;
  require_evidence?: boolean;
  allow_unverified_fallback?: boolean;
}

/** One retrieval request compiled from a cartridge's retrieval policy. */
export interface SubstrateRetrievalRequest {
  cartridgeName: string;
  scopes: MemoryScope[];
  top_k: number;
  max_tokens: number;
  require_evidence: boolean;
  allow_unverified_fallback: boolean;
}

/** Compiled retrieval plan — stored on ExecutionPlan.substrateRetrievalPlan. */
export interface SubstrateRetrievalPlan {
  requests: SubstrateRetrievalRequest[];
  fallbackTopK?: number;
  globalBudget: number;
}

/** A retrieved memory tagged with attribution metadata. */
export interface RetrievedMemory {
  id: string;
  content: string;
  scope: MemoryScope;
  confidence: number;
  provenance?: string;
  score: number;
  requested_by: string[];
  policy_id: string;
  trusted: boolean;
}

/** Bounded output from the Identity Engine. */
export interface IdentitySummary {
  core: string;
  preferences?: string;
  state?: string;
  totalTokens: number;
}

/** Minimal shape the prompter needs — decoupled from registry internals. */
export interface CartridgeBlock {
  name: string;
  scope: string;
  category: CartridgeCategory;
  content: string;
}

/** Resolver output — fully-described cognitive context for a turn. */
export interface ExecutionPlan {
  identity: string;
  interactionPersona?: CartridgeBlock;
  workingRole?: CartridgeBlock;
  defaultRole?: string;
  dependencies: CartridgeBlock[];
  language?: CartridgeBlock;
  framework?: CartridgeBlock;
  project?: CartridgeBlock;
  task?: CartridgeBlock;
  universal: CartridgeBlock[];
  substrateRetrievalPlan?: SubstrateRetrievalPlan;
  budget: { estimated: number; limit: number };
  events: Array<Record<string, unknown> & { type: string }>;
}
