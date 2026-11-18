// @anima/context-engine — standalone DAG context engine
// Extracted from lossless-claw, decoupled from OpenClaw
export { ConversationStore } from './store/conversation-store.js';
export { SummaryStore } from './store/summary-store.js';
export { runMigrations, CONTEXT_SCHEMA } from './store/schema.js';
export { CompactionEngine } from './dag/compaction.js';
export type { CompactionResult } from './dag/compaction.js';
export { ContextAssembler } from './dag/assembler.js';
export type { AssemblyResult } from './dag/assembler.js';
export { estimateTokens, truncateTextToEstimatedTokens } from './dag/estimate-tokens.js';
export type {
  MessageRecord,
  MessagePart,
  MessagePartInput,
  SummaryRecord,
  ContextItem,
  SummaryProvider,
  ContextEngine,
  BootstrapInput,
  BootstrapResult,
  IngestInput,
  AssembleInput,
  AssembleResult,
  CompactInput,
  CompactResult,
  SearchOptions,
  SearchResult,
  IntegrityReport,
  IntegrityCheck,
  CompactionConfig,
} from './types.js';
export { DEFAULT_COMPACTION_CONFIG } from './types.js';
