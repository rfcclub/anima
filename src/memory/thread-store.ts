import { Database } from "bun:sqlite";

export interface ToolSummaryEntry {
  tool: string;
  args?: string;
  resultPreview: string;
}

export interface ThreadMessage {
  role: "user" | "assistant" | "summary";
  content: string;
  toolSummary?: ToolSummaryEntry[];
}

const DEFAULT_MAX_SIZE = 50;
const TOOL_SUMMARY_MAX_CHARS = 2000;
const COMPACTION_SUMMARY_MAX_CHARS = 3000;

export class PersistentThreadStore {
  private db: Database;
  private maxSize: number;

  constructor(db: Database, maxSize: number = DEFAULT_MAX_SIZE) {
    this.db = db;
    this.maxSize = maxSize;
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA busy_timeout=3000");
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS thread_messages (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id   TEXT NOT NULL,
        agent_name   TEXT NOT NULL,
        role         TEXT NOT NULL,
        content      TEXT NOT NULL,
        tool_summary TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_thread_lookup ON thread_messages(channel_id, agent_name, id)"
    );
  }

  add(
    channelId: string,
    agentName: string,
    role: "user" | "assistant",
    content: string,
    toolSummary?: ToolSummaryEntry[],
  ): void {
    const truncatedSummary = toolSummary ? this.truncateToolSummary(toolSummary) : null;

    this.db.run(
      "INSERT INTO thread_messages (channel_id, agent_name, role, content, tool_summary) VALUES (?, ?, ?, ?, ?)",
      [channelId, agentName, role, content, truncatedSummary ? JSON.stringify(truncatedSummary) : null],
    );

    const count = (this.db.query(
      "SELECT COUNT(*) as c FROM thread_messages WHERE channel_id = ? AND agent_name = ?"
    ).get(channelId, agentName) as { c: number }).c;

    if (count > this.maxSize) {
      this.compact(channelId, agentName);
    }
  }

  getThread(channelId: string, agentName: string): ThreadMessage[] {
    const rows = this.db.query(
      "SELECT role, content, tool_summary FROM thread_messages WHERE channel_id = ? AND agent_name = ? ORDER BY id ASC"
    ).all(channelId, agentName) as { role: string; content: string; tool_summary: string | null }[];

    return rows.map(row => {
      const toolSummary = row.tool_summary ? JSON.parse(row.tool_summary) as ToolSummaryEntry[] : undefined;
      let content = row.content;
      if (toolSummary) {
        content += `\n\n[Tools used: ${toolSummary.map(t => `${t.tool}(${t.args ?? ""})`).join(", ")}]`;
      }
      // "summary" stored internally but mapped to "user" for LLM provider compatibility
      return {
        role: (row.role === "summary" ? "user" : row.role) as ThreadMessage["role"],
        content,
        toolSummary,
      };
    });
  }

  clear(channelId: string, agentName: string): void {
    this.db.run(
      "DELETE FROM thread_messages WHERE channel_id = ? AND agent_name = ?",
      [channelId, agentName],
    );
  }

  private compact(channelId: string, agentName: string): void {
    const rows = this.db.query(
      "SELECT id, role, content FROM thread_messages WHERE channel_id = ? AND agent_name = ? ORDER BY id ASC"
    ).all(channelId, agentName) as { id: number; role: string; content: string }[];

    const halfPoint = Math.floor(rows.length / 2);
    const toCompact = rows.slice(0, halfPoint);
    const summary = this.extractSummary(toCompact);

    const idsToDelete = toCompact.map(r => r.id);

    this.db.transaction(() => {
      const placeholders = idsToDelete.map(() => "?").join(",");
      this.db.run(
        `DELETE FROM thread_messages WHERE id IN (${placeholders})`,
        idsToDelete,
      );
      this.db.run(
        "INSERT INTO thread_messages (channel_id, agent_name, role, content, tool_summary) VALUES (?, ?, 'summary', ?, NULL)",
        [channelId, agentName, summary],
      );
    })();

    // Fix ordering: the summary should come before remaining messages.
    // Since we inserted it after the remaining messages exist, its id is higher.
    // Re-order by setting the summary's id to be lower than all remaining.
    const minRemaining = (this.db.query(
      "SELECT MIN(id) as m FROM thread_messages WHERE channel_id = ? AND agent_name = ? AND role != 'summary'"
    ).get(channelId, agentName) as { m: number | null })?.m;

    if (minRemaining !== null) {
      const summaryRow = this.db.query(
        "SELECT id FROM thread_messages WHERE channel_id = ? AND agent_name = ? AND role = 'summary' AND id > ? ORDER BY id DESC LIMIT 1"
      ).get(channelId, agentName, minRemaining) as { id: number } | null;

      if (summaryRow) {
        // Move summary before remaining messages by recreating it with a lower id
        const summaryContent = (this.db.query("SELECT content FROM thread_messages WHERE id = ?").get(summaryRow.id) as { content: string }).content;
        this.db.transaction(() => {
          this.db.run("DELETE FROM thread_messages WHERE id = ?", [summaryRow.id]);
          // Insert with explicit low id
          this.db.run(
            "INSERT INTO thread_messages (id, channel_id, agent_name, role, content, tool_summary) VALUES (?, ?, ?, 'summary', ?, NULL)",
            [minRemaining - 1, channelId, agentName, summaryContent],
          );
        })();
      }
    }
  }

  private extractSummary(messages: { role: string; content: string }[]): string {
    const parts: string[] = ["[Previous conversation summary]"];

    for (const msg of messages) {
      const lines = msg.content.split("\n").filter(l => l.trim());
      if (lines.length === 0) continue;

      const first = lines[0].trim();
      const questions = lines.filter(l => l.trim().endsWith("?")).map(l => l.trim());
      const decisions = lines.filter(l =>
        /→|confirmed|agreed|OK\b|decided|approved/i.test(l)
      ).map(l => l.trim());

      const prefix = msg.role === "user" ? "User" : "Agent";

      if (questions.length > 0) {
        parts.push(`${prefix}: ${questions.join(" | ")}`);
      } else if (decisions.length > 0) {
        parts.push(`${prefix}: ${decisions.join(" | ")}`);
      } else {
        parts.push(`${prefix}: ${first}`);
        if (lines.length > 1) {
          const last = lines[lines.length - 1].trim();
          if (last !== first) parts.push(`  ...${last}`);
        }
      }
    }

    let summary = parts.join("\n");
    if (summary.length > COMPACTION_SUMMARY_MAX_CHARS) {
      summary = summary.slice(0, COMPACTION_SUMMARY_MAX_CHARS - 3) + "...";
    }
    return summary;
  }

  private truncateToolSummary(tools: ToolSummaryEntry[]): ToolSummaryEntry[] {
    const result: ToolSummaryEntry[] = [];
    let totalLen = 0;

    for (const t of tools) {
      const preview = t.resultPreview.length > 100
        ? t.resultPreview.slice(0, 100)
        : t.resultPreview;
      const entry: ToolSummaryEntry = {
        tool: t.tool,
        args: t.args,
        resultPreview: preview,
      };
      const entryLen = JSON.stringify(entry).length;
      if (totalLen + entryLen > TOOL_SUMMARY_MAX_CHARS) break;
      totalLen += entryLen;
      result.push(entry);
    }

    return result;
  }
}

// ── In-memory ThreadStore (backward compatible, for tests & lightweight usage) ──

const INMEM_MAX_THREAD_SIZE = 20;
const INMEM_MAX_THREADS = 100;

export class ThreadStore {
  private threads = new Map<string, ThreadMessage[]>();
  private lruOrder: string[] = [];

  add(channelId: string, agentName: string, role: "user" | "assistant", content: string): void {
    const k = this.key(channelId, agentName);
    this.touch(k);

    let thread = this.threads.get(k);
    if (!thread) {
      thread = [];
      this.threads.set(k, thread);
    }

    thread.push({ role, content });

    while (thread.length > INMEM_MAX_THREAD_SIZE) {
      thread.shift();
    }
  }

  getThread(channelId: string, agentName: string): ThreadMessage[] {
    const k = this.key(channelId, agentName);
    const thread = this.threads.get(k);
    if (thread) this.touch(k);
    return thread ?? [];
  }

  clear(channelId: string, agentName: string): void {
    const k = this.key(channelId, agentName);
    this.threads.delete(k);
    const idx = this.lruOrder.indexOf(k);
    if (idx !== -1) this.lruOrder.splice(idx, 1);
  }

  private key(channelId: string, agentName: string): string {
    return `${channelId}:${agentName}`;
  }

  private touch(key: string): void {
    const idx = this.lruOrder.indexOf(key);
    if (idx !== -1) this.lruOrder.splice(idx, 1);
    this.lruOrder.push(key);

    while (this.lruOrder.length > INMEM_MAX_THREADS) {
      const evict = this.lruOrder.shift()!;
      this.threads.delete(evict);
    }
  }
}
