import type {
  EvidenceMetadata,
  RetrievalResult,
  TrustLevel,
} from "./substrate-adapter";

// ─── Retrieval Plan ───────────────────────────────────────────────

/** Cartridge declares which scopes it needs and fallback behaviour. */
export interface CartridgeRetrievalPolicy {
  required?: string[];
  preferred?: string[];
  optional?: string[];
  topK?: number;
  maxTokens?: number;
  requireEvidence?: boolean;
  fallback?: Record<string, ScopeFallback>;
}

export type FallbackAction =
  | "block"
  | "ask_for_context"
  | "continue_with_warning"
  | "continue"
  | "continue_with_generic"
  | "continue_with_placeholder";

export interface ScopeFallback {
  onMissing: FallbackAction;
  message?: string;
}

/** Resolution of a single cartridge's retrieval policy against available scopes. */
export interface ResolvedCartridgeRetrieval {
  cartridgeId: string;
  scopesIncluded: string[];
  scopesMissing: string[];
  scopesDegraded: string[];
  fallbackActions: Record<string, FallbackAction>;
  blocked: boolean;
  blockReason?: string;
}

// ─── Turn Context ─────────────────────────────────────────────────

/** Runtime invariants — always assembled, never removed. */
export const RUNTIME_REQUIRED_SCOPES = ["identity_core", "current_state"] as const;

/** Agent-level defaults: may add scopes, cannot remove runtime-required. */
export interface AgentDefaults {
  agentId: string;
  defaultScopes?: string[];
}

/** Full turn context assembled from runtime + agent + cartridge layers. */
export interface TurnContext {
  agentId: string;
  runtimeRequiredScopes: string[];
  agentDefaults: AgentDefaults;
  cartridgePolicies: ResolvedCartridgeRetrieval[];
  /** Deduplicated union of all scopes requested across all layers. */
  unifiedScopes: string[];
  requireEvidence: boolean;
  maxTokens?: number;
  topK?: number;
  query?: string;
}

// ─── Substrate View ───────────────────────────────────────────────

/** Assembled view after retrieval — the canonical payload before prompt formatting. */
export interface SubstrateView {
  turnContext: TurnContext;
  results: RetrievalResult[];
  /** Estimated token count of all result content. */
  estimatedTokens: number;
  scopesCovered: string[];
  scopesMissing: string[];
  scopesEmpty: string[];
  warnings: SubstrateViewWarning[];
}

export interface SubstrateViewWarning {
  scope: string;
  code: string;
  message: string;
  action: FallbackAction;
}

// ─── Prompt Assembler ─────────────────────────────────────────────

/** A single block of context in the assembled prompt. */
export interface PromptContextBlock {
  scope: string;
  label: string;
  content: string;
  trust: TrustLevel;
  weight: number;
  evidence?: EvidenceMetadata;
  cartridgeIds: string[];
}

/** Final assembled context ready for injection into the model prompt. */
export interface PromptContext {
  blocks: PromptContextBlock[];
  totalTokens: number;
  tokenBudget: number;
  truncated: boolean;
  warnings: string[];
}

export interface AssembleOptions {
  /** Hard token cap; blocks beyond this are dropped (lowest weight first). */
  maxTokens?: number;
  /** Scope ordering override — scopes listed first appear first. */
  prioritizeScopes?: string[];
  /** Output format for each block. */
  format?: "markdown" | "yaml";
  /** Whether to inline evidence metadata into the block content. */
  includeEvidence?: boolean;
}

/** Turns a SubstrateView into a PromptContext for model injection. */
export interface PromptAssembler {
  assemble(view: SubstrateView, options?: AssembleOptions): PromptContext;
}

// ─── Substrate View Layer ─────────────────────────────────────────

/**
 * Orchestrates retrieval across runtime-required scopes + agent defaults +
 * cartridge policies, producing a SubstrateView.
 *
 * This is the single entry-point called by the Identity Engine each turn.
 * It does NOT format for the prompt — that's PromptAssembler's job.
 */
export interface SubstrateViewLayer {
  /**
   * Build a SubstrateView for a turn.
   *
   * @param cartridgePolicies — resolved retrieval policies from active cartridges
   * @param agentDefaults — agent-level default scopes
   * @param adapter — the agent's substrate adapter
   * @param query — optional natural-language query for filtering/scoring
   */
  buildView(params: BuildViewParams): Promise<SubstrateView>;
}

export interface BuildViewParams {
  cartridgePolicies: ResolvedCartridgeRetrieval[];
  agentDefaults: AgentDefaults;
  adapter: import("./substrate-adapter").SubstrateAdapter;
  query?: string;
  maxTokens?: number;
}
