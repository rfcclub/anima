// @anima/context-engine — public types
// OpenClaw-free. Based on lossless-claw types but decoupled from OC lifecycle.

export interface MessageRecord {
  id: string;
  conversation_id?: string;
  seq: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  token_count?: number;
  created_at: string;
  parts?: MessagePart[];
}

export interface MessagePart {
  type: 'text' | 'tool_call' | 'tool_result' | 'reasoning';
  text?: string;
  tool_name?: string;
  tool_args?: Record<string, unknown>;
  tool_result?: string;
  tool_call_id?: string;
}

/** Structured message part for the message_parts table, mirroring lossless-claw. */
export interface MessagePartInput {
  sessionId?: string;
  partType: string;
  ordinal: number;
  textContent?: string | null;
  isIgnored?: number | null;
  isSynthetic?: number | null;
  toolCallId?: string | null;
  toolName?: string | null;
  toolStatus?: string | null;
  toolInput?: string | null;
  toolOutput?: string | null;
  toolError?: string | null;
  toolTitle?: string | null;
  patchHash?: string | null;
  patchFiles?: string | null;
  fileMime?: string | null;
  fileName?: string | null;
  fileUrl?: string | null;
  subtaskPrompt?: string | null;
  subtaskDesc?: string | null;
  subtaskAgent?: string | null;
  stepReason?: string | null;
  stepCost?: number | null;
  stepTokensIn?: number | null;
  stepTokensOut?: number | null;
  snapshotHash?: string | null;
  compactionAuto?: number | null;
  metadata?: string | null;
}

export interface SummaryRecord {
  summary_id: string;
  conversation_id: string;
  kind: 'leaf' | 'condensed';
  depth: number;
  content: string;
  token_count?: number;
  descendant_count?: number;
  descendant_token_count?: number;
  source_message_token_count?: number;
  earliest_at?: string;
  latest_at?: string;
  model?: string;
  created_at: string;
}

export interface ContextItem {
  conversation_id: string;
  ordinal: number;
  item_type: 'message' | 'summary';
  message_id?: string;
  summary_id?: string;
}

export interface SummaryProvider {
  complete(params: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{
    content: string;
    model?: string;
    usage?: { inputTokens: number; outputTokens: number };
  }>;
}

export interface ContextEngine {
  initialize(agentId: string, platform: string): Promise<void>;
  bootstrap(input: BootstrapInput): Promise<BootstrapResult>;
  ingest(input: IngestInput): Promise<void>;
  assemble(input: AssembleInput): Promise<AssembleResult>;
  compact(input: CompactInput): Promise<CompactResult>;
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  checkIntegrity(): Promise<IntegrityReport>;
  dispose(): void;
}

export interface BootstrapInput {
  conversationId?: string;
  messages?: MessageRecord[];
}

export interface BootstrapResult {
  importedCount: number;
  conversationId: string;
}

export interface IngestInput {
  conversationId: string;
  message: MessageRecord;
  /** Raw agent message (pre-mapping) for building structured message_parts */
  rawAgentMessage?: unknown;
  /** Session ID for message_parts table */
  sessionId?: string;
}

export interface AssembleInput {
  conversationId: string;
  prompt?: string;
  tokenBudget?: number;
}

export interface AssembleResult {
  messages: MessageRecord[];
  estimatedTokens: number;
  freshTailCount: number;
  systemPromptAddition?: string;
}

export interface CompactInput {
  conversationId: string;
  targetTokens?: number;
  currentTokens?: number;
}

export interface CompactResult {
  compacted: boolean;
  summariesCreated: number;
  tokensBefore: number;
  tokensAfter: number;
}

export interface SearchOptions {
  conversationId?: string;
  mode?: 'full_text' | 'regex';
  scope?: 'messages' | 'summaries' | 'both';
  limit?: number;
}

export interface SearchResult {
  type: 'message' | 'summary';
  id: string;
  content: string;
  snippet: string;
  created_at: string;
}

export interface IntegrityReport {
  healthy: boolean;
  checks: IntegrityCheck[];
}

export interface IntegrityCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface CompactionConfig {
  leafChunkTokens: number;
  condensedMinFanout: number;
  condensedMinFanoutHard: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  freshTailCount: number;
  maxSweepIterations: number;
  sweepDeadlineMs: number;
  maxRounds: number;
  compactUntilUnderDeadlineMs: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  leafChunkTokens: 20_000,
  condensedMinFanout: 4,
  condensedMinFanoutHard: 2,
  leafTargetTokens: 2_400,
  condensedTargetTokens: 2_000,
  freshTailCount: 64,
  maxSweepIterations: 12,
  sweepDeadlineMs: 120_000,
  maxRounds: 10,
  compactUntilUnderDeadlineMs: 300_000,
};
