/**
 * TrajectoryManager — Append-only log of agent state transitions.
 *
 * Agent trajectories track how an agent changes across sessions:
 * - snapshot: Session boundary record (open/close)
 * - shift: Identity/behavior change detected
 * - milestone: Notable growth event
 *
 * Records are stored in `trajectory.jsonl` in the agent's substrate directory.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type TrajectoryRecordType = "snapshot" | "shift" | "milestone";

export interface TrajectoryRecord {
  id: string;
  timestamp: string;
  type: TrajectoryRecordType;
  agent: string;
  sessionId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ShiftMetadata {
  what: string;
  from: string;
  to: string;
  trigger: string;
}

/* ------------------------------------------------------------------ */
/*  TrajectoryManager                                                  */
/* ------------------------------------------------------------------ */

/**
 * TrajectoryManager — append-only log of agent state transitions.
 *
 * Records three types of trajectory events: snapshot (session boundaries),
 * shift (identity/behavior changes), and milestone (notable growth events).
 * Entries are stored as JSONL in the agent's substrate directory and can be
 * formatted for system prompt injection to provide continuity context across
 * sessions. Records are deduplicated by ID and sorted by timestamp.
 */
export class TrajectoryManager {
  private readonly filePath: string;

  constructor(private readonly substrateDir: string) {
    this.filePath = join(substrateDir, "trajectory.jsonl");
  }

  /**
   * Append a snapshot record (session boundary).
   */
  appendSnapshot(sessionId: string, agent: string, content: string, metadata?: Record<string, unknown>): string {
    return this.append("snapshot", sessionId, agent, content, metadata);
  }

  /**
   * Append a shift record (identity/behavior change).
   */
  appendShift(sessionId: string, agent: string, shift: ShiftMetadata, metadata?: Record<string, unknown>): string {
    return this.append("shift", sessionId, agent, shift.what, {
      ...metadata,
      from: shift.from,
      to: shift.to,
      trigger: shift.trigger,
    });
  }

  /**
   * Append a milestone record (notable growth event).
   */
  appendMilestone(sessionId: string, agent: string, content: string, metadata?: Record<string, unknown>): string {
    return this.append("milestone", sessionId, agent, content, metadata);
  }

  /**
   * Get the last N records, deduplicated by id, sorted by timestamp descending.
   */
  getRecent(count: number = 5): TrajectoryRecord[] {
    if (!existsSync(this.filePath)) return [];

    const raw = readFileSync(this.filePath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);

    // Parse all records
    const records: TrajectoryRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    // Deduplicate by id (keep last occurrence)
    const seen = new Map<string, TrajectoryRecord>();
    for (const record of records) {
      seen.set(record.id, record);
    }

    // Sort by timestamp descending (newest first)
    const unique = [...seen.values()].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return unique.slice(0, count);
  }

  /**
   * Format recent trajectory records for system prompt injection.
   * Returns empty string if no records.
   */
  formatTrajectoryContext(count: number = 5): string {
    const records = this.getRecent(count);
    if (records.length === 0) return "";

    const sections: string[] = ["[Trajectory]"];

    for (const record of records) {
      const time = record.timestamp.slice(0, 16).replace("T", " ");
      const metaStr = record.metadata
        ? " " + Object.entries(record.metadata)
            .filter(([k]) => k !== "heartwood") // Skip internal flags
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
        : "";
      sections.push(`[${record.type}] ${time} | ${record.agent} [${record.sessionId}]: ${record.content}${metaStr}`);
    }

    return sections.join("\n");
  }

  /* ------------------------------------------------------------------ */
  /*  Internal                                                           */
  /* ------------------------------------------------------------------ */

  private append(
    type: TrajectoryRecordType,
    sessionId: string,
    agent: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): string {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record: TrajectoryRecord = {
      id,
      timestamp: new Date().toISOString(),
      type,
      agent,
      sessionId,
      content,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    };

    const line = JSON.stringify(record) + "\n";

    if (existsSync(this.filePath)) {
      writeFileSync(this.filePath, line, { flag: "a" });
    } else {
      writeFileSync(this.filePath, line);
    }

    return id;
  }
}
