/**
 * lcm_grep — FTS5 search against context.db
 *
 * Searches messages_fts and summaries_fts virtual tables in the DAG context
 * database and returns matching snippets with metadata.
 */

import { DatabaseSync } from "node:sqlite";
import type { AnimaTool } from "../types.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAX_RESULT_CHARS = 40_000; // ~10k tokens

/* ------------------------------------------------------------------ */
/*  Schema                                                             */
/* ------------------------------------------------------------------ */

interface LcmGrepParams {
  pattern: string;
  mode?: "regex" | "full_text";
  scope?: "messages" | "summaries" | "both";
  conversationId?: string;
  allConversations?: boolean;
  since?: string;
  before?: string;
  limit?: number;
  sort?: "recency" | "relevance" | "hybrid";
}

interface MatchEntry {
  type: "message" | "summary";
  id: string;
  conversationId: string;
  content: string;
  snippet: string;
  created_at: string;
  seq?: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function truncateSnippet(content: string, maxLen: number = 200): string {
  const singleLine = content.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.substring(0, maxLen - 3) + "...";
}

function sanitizeFtsQuery(query: string): string {
  return query.replace(/["'*+^:~()-]/g, " ").trim().replace(/"/g, "");
}

function formatDisplayTime(value: string | null | undefined): string {
  if (!value) return "-";
  try {
    return new Date(value).toISOString();
  } catch {
    return "-";
  }
}

/* ------------------------------------------------------------------ */
/*  Tool factory                                                       */
/* ------------------------------------------------------------------ */

export function createLcmGrepTool(getDb: () => DatabaseSync | null): AnimaTool {
  return {
    name: "lcm_grep",
    description:
      "Search compacted conversation history using full-text search. " +
      "Searches across messages and/or summaries stored in the DAG context database. " +
      "Returns matching snippets with their summary/message IDs for follow-up with lcm_expand or lcm_describe.",

    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            'Search pattern. When mode is "full_text", uses FTS5 AND semantics (prefer 1-3 distinctive terms or one quoted phrase).',
        },
        mode: {
          type: "string",
          enum: ["regex", "full_text"],
          description: 'Search mode. Default: "full_text".',
        },
        scope: {
          type: "string",
          enum: ["messages", "summaries", "both"],
          description: 'What to search. Default: "both".',
        },
        conversationId: {
          type: "string",
          description: "Conversation ID to scope search to. If omitted, searches all.",
        },
        since: {
          type: "string",
          description: "Only return matches at or after this ISO timestamp.",
        },
        before: {
          type: "string",
          description: "Only return matches before this ISO timestamp.",
        },
        limit: {
          type: "number",
          description: "Maximum results (default: 50, max: 200).",
        },
        sort: {
          type: "string",
          enum: ["recency", "relevance", "hybrid"],
          description: 'Sort order. Default: "recency".',
        },
      },
      required: ["pattern"],
    },

    async execute(_toolCallId: string, params: unknown) {
      const db = getDb();
      if (!db) {
        throw new Error("Anima context engine database is unavailable.");
      }

      const p = params as LcmGrepParams;
      const pattern = p.pattern?.trim() ?? "";
      if (!pattern) {
        return { content: [{ type: "text", text: "No search pattern provided." }] };
      }

      const mode = p.mode ?? "full_text";
      const scope = p.scope ?? "both";
      const limit = Math.min(Math.max(1, p.limit ?? 50), 200);
      const sort = p.sort ?? "recency";
      const conversationId = p.conversationId?.trim();

      const results: MatchEntry[] = [];

      if (mode === "full_text") {
        const safe = sanitizeFtsQuery(pattern);
        if (!safe) {
          return { content: [{ type: "text", text: "Empty query after sanitization." }] };
        }

        if (scope === "both" || scope === "messages") {
          try {
            const messages = queryMessagesFts(db, safe, conversationId, limit, sort);
            for (const msg of messages) {
              const content = (msg.content as string) ?? "";
              results.push({
                type: "message",
                id: msg.message_id as string,
                conversationId: msg.conversation_id as string,
                content,
                snippet: truncateSnippet(content),
                created_at: msg.created_at as string,
                seq: msg.seq as number,
              });
            }
          } catch {
            // best-effort
          }
        }

        if (scope === "both" || scope === "summaries") {
          try {
            const summaries = querySummariesFts(db, safe, conversationId, limit, sort);
            for (const s of summaries) {
              const content = s.content as string;
              results.push({
                type: "summary",
                id: s.summary_id as string,
                conversationId: s.conversation_id as string,
                content,
                snippet: truncateSnippet(content),
                created_at: s.created_at as string,
              });
            }
          } catch {
            // best-effort
          }
        }
      } else {
        // regex mode — fall back to LIKE-based search
        try {
          if (scope === "both" || scope === "messages") {
            const messages = queryMessagesLike(db, pattern, conversationId, limit);
            for (const msg of messages) {
              const content = (msg.content as string) ?? "";
              results.push({
                type: "message",
                id: msg.message_id as string,
                conversationId: msg.conversation_id as string,
                content,
                snippet: truncateSnippet(content),
                created_at: msg.created_at as string,
                seq: msg.seq as number,
              });
            }
          }
          if (scope === "both" || scope === "summaries") {
            const summaries = querySummariesLike(db, pattern, conversationId, limit);
            for (const s of summaries) {
              const content = s.content as string;
              results.push({
                type: "summary",
                id: s.summary_id as string,
                conversationId: s.conversation_id as string,
                content,
                snippet: truncateSnippet(content),
                created_at: s.created_at as string,
              });
            }
          }
        } catch {
          // best-effort
        }
      }

      // Apply time filters
      const since = p.since ? new Date(p.since) : null;
      const before = p.before ? new Date(p.before) : null;
      let filtered = results;
      if (since || before) {
        filtered = results.filter((r) => {
          const dt = new Date(r.created_at).getTime();
          if (since && dt < since.getTime()) return false;
          if (before && dt >= before.getTime()) return false;
          return true;
        });
      }

      // Sort
      if (sort === "relevance" && mode === "full_text") {
        // Already ordered by FTS rank
      } else if (sort === "hybrid" && mode === "full_text") {
        // Interleave: recent first, then relevance — deduplicated
        const mid = Math.ceil(filtered.length / 2);
        const recent = filtered.slice().sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );
        const seen = new Set<string>();
        filtered = [];
        for (let i = 0; i < mid; i++) {
          const rKey = `${recent[i].type}:${recent[i].id}`;
          if (!seen.has(rKey)) { seen.add(rKey); filtered.push(recent[i]); }
        }
        for (const item of filtered.slice()) {
          const iKey = `${item.type}:${item.id}`;
          if (!seen.has(iKey)) { seen.add(iKey); filtered.push(item); }
        }
        // fill remaining from recency that weren't already in top relevance
        for (let i = mid; i < recent.length && filtered.length < recent.length; i++) {
          const rKey = `${recent[i].type}:${recent[i].id}`;
          if (!seen.has(rKey)) { seen.add(rKey); filtered.push(recent[i]); }
        }
      } else {
        // recency (default)
        filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      }

      const finalResults = filtered.slice(0, limit);

      if (finalResults.length === 0) {
        return { content: [{ type: "text", text: "No matches found." }] };
      }

      // Format output
      const lines: string[] = [
        `LCM_GREP results (${finalResults.length}): mode=${mode} scope=${scope}`,
        "",
      ];
      let totalChars = 0;

      for (const r of finalResults) {
        const header = `${r.type === "message" ? "MSG" : "SUM"} ${r.id} conv=${r.conversationId} ts=${formatDisplayTime(r.created_at)}`;
        const line = `${header}\n${r.snippet}`;

        if (totalChars + line.length > MAX_RESULT_CHARS) {
          lines.push("... (truncated)");
          break;
        }

        lines.push(line);
        lines.push("");
        totalChars += line.length;
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  FTS queries                                                        */
/* ------------------------------------------------------------------ */

function queryMessagesFts(
  db: DatabaseSync,
  safeQuery: string,
  conversationId?: string,
  limit: number = 50,
  sort: string = "recency",
): Array<Record<string, unknown>> {
  const orderBy = sort === "relevance" ? "rank" : "m.created_at DESC";
  if (conversationId) {
    return db
      .prepare(
        `SELECT m.* FROM messages m
         JOIN messages_fts f ON m.rowid = f.rowid
         WHERE messages_fts MATCH ? AND m.conversation_id = ?
         ORDER BY ${orderBy}
         LIMIT ?`,
      )
      .all(`"${safeQuery}"`, conversationId, limit) as Array<Record<string, unknown>>;
  }
  return db
    .prepare(
      `SELECT m.* FROM messages m
       JOIN messages_fts f ON m.rowid = f.rowid
       WHERE messages_fts MATCH ?
       ORDER BY ${orderBy}
       LIMIT ?`,
    )
    .all(`"${safeQuery}"`, limit) as Array<Record<string, unknown>>;
}

function querySummariesFts(
  db: DatabaseSync,
  safeQuery: string,
  conversationId?: string,
  limit: number = 50,
  sort: string = "recency",
): Array<Record<string, unknown>> {
  const orderBy = sort === "relevance" ? "rank" : "s.created_at DESC";
  if (conversationId) {
    return db
      .prepare(
        `SELECT s.* FROM summaries s
         JOIN summaries_fts f ON s.rowid = f.rowid
         WHERE summaries_fts MATCH ? AND s.conversation_id = ?
         ORDER BY ${orderBy}
         LIMIT ?`,
      )
      .all(`"${safeQuery}"`, conversationId, limit) as Array<Record<string, unknown>>;
  }
  return db
    .prepare(
      `SELECT s.* FROM summaries s
       JOIN summaries_fts f ON s.rowid = f.rowid
       WHERE summaries_fts MATCH ?
       ORDER BY ${orderBy}
       LIMIT ?`,
    )
    .all(`"${safeQuery}"`, limit) as Array<Record<string, unknown>>;
}

/* ------------------------------------------------------------------ */
/*  LIKE-based search (regex fallback)                                 */
/* ------------------------------------------------------------------ */

function queryMessagesLike(
  db: DatabaseSync,
  pattern: string,
  conversationId?: string,
  limit: number = 50,
): Array<Record<string, unknown>> {
  const likePattern = `%${pattern.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
  if (conversationId) {
    return db
      .prepare(
        "SELECT * FROM messages WHERE content LIKE ? AND conversation_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(likePattern, conversationId, limit) as Array<Record<string, unknown>>;
  }
  return db
    .prepare(
      "SELECT * FROM messages WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(likePattern, limit) as Array<Record<string, unknown>>;
}

function querySummariesLike(
  db: DatabaseSync,
  pattern: string,
  conversationId?: string,
  limit: number = 50,
): Array<Record<string, unknown>> {
  const likePattern = `%${pattern.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
  if (conversationId) {
    return db
      .prepare(
        "SELECT * FROM summaries WHERE content LIKE ? AND conversation_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(likePattern, conversationId, limit) as Array<Record<string, unknown>>;
  }
  return db
    .prepare(
      "SELECT * FROM summaries WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(likePattern, limit) as Array<Record<string, unknown>>;
}
