export interface MemoryEntry {
  id?: string;
  namespace: string;        // agent name or "common"
  content: string;
  type: "message" | "observation" | "episode" | "fact";
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export type RecallMode = 'normal' | 'semantic' | 'neural';

export interface RecallOptions {
  namespace?: string;
  topK?: number;
  mode?: RecallMode;
  recentDays?: number;
  sessionStore?: unknown;   // SessionStore ref for normal mode
  sessionId?: string;       // current session ID
}

export interface MemoryAdapter {
  store(entry: MemoryEntry): Promise<void>;
  recall(query: string, opts?: RecallOptions): Promise<MemoryEntry[]>;
}
