import { SessionStore, type SessionRecord, type TurnRecord } from "../memory/session-store";
import { detectReboot } from "./boot-id";

export interface CompactionConfig {
  softThreshold: number;
  hardThreshold: number;
  protectedRecentTurns: number;
  summaryRatio: number;
}

const DEFAULT_COMPACTION: CompactionConfig = {
  softThreshold: 0.70,
  hardThreshold: 0.85,
  protectedRecentTurns: 6,
  summaryRatio: 0.15,
};

export interface SessionManagerOptions {
  store: SessionStore;
  compaction?: Partial<CompactionConfig>;
  maxTokens?: number;
  idleTimeoutMS?: number;
  onIdle?: (agent: string, channel: string) => void;
  onEnd?: (sessionId: string, agent: string) => Promise<void>;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly compaction: CompactionConfig;
  private readonly maxTokens: number;
  private readonly idleTimeoutMS?: number;
  private readonly onIdle?: (agent: string, channel: string) => void;
  private readonly onEnd?: (sessionId: string, agent: string) => Promise<void>;
  private activeSessions = new Map<string, string>();

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.compaction = { ...DEFAULT_COMPACTION, ...options.compaction };
    this.maxTokens = options.maxTokens ?? 200_000;
    this.idleTimeoutMS = options.idleTimeoutMS;
    this.onIdle = options.onIdle;
    this.onEnd = options.onEnd;
    detectReboot(); // persist boot_id on startup
  }

  openSession(agent: string, channel: string): SessionRecord {
    const key = `${agent}:${channel}`;
    const existingId = this.activeSessions.get(key);
    if (existingId) {
      const session = this.store.getSession(existingId);
      if (session && !session.ended) {
        this.store.ensureMainBranch(session.id);
        return session;
      }
    }
    // Fall back to DB lookup — in-memory cache is lost across requests
    const latest = this.store.getLatestSession(agent, channel);
    if (latest && !latest.ended) {
      this.activeSessions.set(key, latest.id);
      this.store.ensureMainBranch(latest.id);
      return latest;
    }
    const session = this.store.createSession(agent, channel);
    this.store.ensureMainBranch(session.id);
    this.activeSessions.set(key, session.id);
    return session;
  }

  newSession(agent: string, channel: string): SessionRecord {
    const key = `${agent}:${channel}`;
    const existingId = this.activeSessions.get(key);
    if (existingId) {
      // Fire onEnd hook before ending the session
      if (this.onEnd) {
        this.onEnd(existingId, agent).catch((err) =>
          console.error("[session-manager] onEnd hook failed:", err),
        );
      }
      this.store.endSession(existingId);
      this.activeSessions.delete(key);
    } else {
      // Close whatever's latest in DB
      const latest = this.store.getLatestSession(agent, channel);
      if (latest && !latest.ended) {
        if (this.onEnd) {
          this.onEnd(latest.id, agent).catch((err) =>
            console.error("[session-manager] onEnd hook failed:", err),
          );
        }
        this.store.endSession(latest.id);
      }
    }
    const session = this.store.createSession(agent, channel);
    this.store.ensureMainBranch(session.id);
    this.activeSessions.set(key, session.id);
    return session;
  }

  appendTurn(sessionId: string, role: "user" | "assistant", content: string): TurnRecord {
    const activeBranch = this.store.getActiveBranch(sessionId);
    const branchId = activeBranch?.id ?? null;
    const turn = this.store.appendTurn(sessionId, role, content, branchId);
    this.checkCompaction(sessionId);
    return turn;
  }

  getTurns(sessionId: string): TurnRecord[] {
    return this.store.getTurns(sessionId);
  }

  getActiveBranchTurns(sessionId: string): TurnRecord[] {
    const branch = this.store.getActiveBranch(sessionId);
    if (branch) {
      return this.store.getTurnsForBranch(branch.id);
    }
    return this.store.getTurns(sessionId);
  }

  closeSession(agent: string, channel: string): void {
    const key = `${agent}:${channel}`;
    // The in-memory map is empty on a manager that did not open the session
    // (a cron builds a fresh one each run), so fall back to the store.
    const latest = this.activeSessions.has(key) ? null : this.store.getLatestSession(agent, channel);
    const sessionId = this.activeSessions.get(key) ?? (latest && !latest.ended ? latest.id : undefined);
    if (sessionId) {
      // Fire onEnd hook before ending the session
      if (this.onEnd) {
        this.onEnd(sessionId, agent).catch((err) =>
          console.error("[session-manager] onEnd hook failed:", err),
        );
      }
      this.store.endSession(sessionId);
      this.activeSessions.delete(key);
    }
  }

  resetSession(sessionId: string): void {
    this.store.deleteAllTurns(sessionId);
  }

  checkCompaction(sessionId: string): { needed: boolean; level?: "soft" | "hard" } {
    const turns = this.store.getTurns(sessionId);
    let total = 0;
    for (const t of turns) total += t.content.length;
    const tokens = Math.ceil(total / 4);
    const ratio = tokens / this.maxTokens;
    if (ratio >= this.compaction.hardThreshold) return { needed: true, level: "hard" };
    if (ratio >= this.compaction.softThreshold) return { needed: true, level: "soft" };
    return { needed: false };
  }

  async compact(sessionId: string, _level: "soft" | "hard" = "soft"): Promise<{ deleted: number }> {
    const activeBranch = this.store.getActiveBranch(sessionId);
    if (activeBranch) {
      const deleted = this.store.softDeleteTurnsOnBranch(activeBranch.id, this.compaction.protectedRecentTurns);
      return { deleted };
    }
    // Fallback for sessions without branches (legacy)
    const protected_ = this.store.getProtectedTurns(sessionId, this.compaction.protectedRecentTurns);
    if (protected_.length === 0) return { deleted: 0 };
    const cutoffId = protected_[0].id;
    const deleted = this.store.softDeleteTurns(sessionId, cutoffId);
    return { deleted };
  }
}
