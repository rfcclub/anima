export type TrustLevel = "low" | "medium" | "high";

export interface SubstrateSource {
  type: "paths" | "soul"; // v1 only; reserved: sqlite, graph, mcp, harness_jsonl
  paths: string[];
  trust: TrustLevel;
  weight: number; // 0.0–1.0
  evidenceRequired: boolean;
}

export interface ScopeDefinition {
  name: string;
  description: string;
  required: boolean;
  sources: SubstrateSource[];
}

export interface ResolvedFile {
  absolutePath: string;
  relativePath: string;
  scope: string;
  sourceIndex: number;
  trust: TrustLevel;
  weight: number;
  evidenceRequired: boolean;
}

export interface ResolvedScope {
  name: string;
  description: string;
  required: boolean;
  files: ResolvedFile[];
}

export interface EvidenceMetadata {
  confidence?: number;
  provenance?: string;
  episodeId?: string;
  sourceLink?: string;
  parentMemoryId?: string;
}

export type RetrievalStatus =
  | "ok"
  | "missing_scope"
  | "empty"
  | "unsupported_source"
  | "error";

export interface RetrievalResult {
  id: string;
  absolutePath: string;
  relativePath: string;
  content: string;
  scopesMatched: string[];
  sourceIds: string[];
  requestedBy: string[];
  trust: TrustLevel;
  weight: number;
  score?: number;
  evidence?: EvidenceMetadata;
  status: RetrievalStatus;
}

export interface RetrievalRequest {
  scopes: string[];
  query?: string;
  topK?: number;
  maxTokens?: number;
  requireEvidence?: boolean;
}

export interface ValidationDiagnostic {
  path: string;
  code: string;
  severity: "error" | "warning";
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  diagnostics: ValidationDiagnostic[];
}

export interface SubstrateAdapter {
  agentId: string;
  substrateType: string;

  listScopes(): ScopeDefinition[];
  hasScope(scope: string): boolean;
  resolve(scope: string): ResolvedScope;
  retrieve(request: RetrievalRequest): Promise<RetrievalResult[]>;
  validateMap(): ValidationResult;
}

export type { SubstrateViewLayer } from "./substrate-view";
