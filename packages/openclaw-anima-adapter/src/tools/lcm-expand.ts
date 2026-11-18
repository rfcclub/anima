/**
 * lcm_expand — DAG node expansion
 *
 * Given a summary ID, traverses summary_parents and summary_messages tables
 * to retrieve the DAG lineage: parent summaries and source messages that
 * were compacted into the given summary.
 */

import { DatabaseSync } from "node:sqlite";
import type { AnimaTool } from "../types.js";

/* ------------------------------------------------------------------ */
/*  Schema                                                             */
/* ------------------------------------------------------------------ */

interface LcmExpandParams {
  summaryIds?: string[];
  query?: string;
  maxDepth?: number;
  tokenCap?: number;
  includeMessages?: boolean;
  conversationId?: string;
  allConversations?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Row type                                                           */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/*  Tool factory                                                       */
/* ------------------------------------------------------------------ */

export function createLcmExpandTool(getDb: () => DatabaseSync | null): AnimaTool {
  return {
    name: "lcm_expand",
    description:
      "Expand compacted conversation summaries from the DAG. " +
      "Traverses the summary_parents and summary_messages tables to retrieve " +
      "the DAG lineage. Provide summaryIds (direct expansion) or query (grep-first, then expand top matches).",

    parameters: {
      type: "object",
      properties: {
        summaryIds: {
          type: "array",
          items: { type: "string" },
          description: "Summary IDs to expand (sum_xxx format). Required if query is not provided.",
        },
        query: {
          type: "string",
          description:
            "Text query to grep for matching summaries before expanding. If provided, summaryIds is ignored.",
        },
        maxDepth: {
          type: "number",
          description: "Max traversal depth per summary (default: 3).",
        },
        includeMessages: {
          type: "boolean",
          description: "Whether to include raw source messages at leaf level (default: false).",
        },
        conversationId: {
          type: "string",
          description: "Conversation ID to scope the expansion. If omitted, searches all.",
        },
        allConversations: {
          type: "boolean",
          description: "Set true to allow cross-conversation expansion.",
        },
      },
    },

    async execute(_toolCallId: string, params: unknown) {
      const db = getDb();
      if (!db) {
        throw new Error("Anima context engine database is unavailable.");
      }

      const p = params as LcmExpandParams;
      const maxDepth = Math.min(Math.max(1, p.maxDepth ?? 3), 10);
      const includeMessages = p.includeMessages ?? false;

      // Resolve target summary IDs
      let targetIds: string[] = [];

      if (p.query?.trim()) {
        // Grep-first mode: search summaries via FTS
        const safe = p.query.trim().replace(/["'*+^:~()-]/g, " ").trim();
        if (safe) {
          const matched = db
            .prepare(
              `SELECT s.summary_id, s.created_at FROM summaries s
               JOIN summaries_fts f ON s.rowid = f.rowid
               WHERE summaries_fts MATCH ?
               ORDER BY s.created_at DESC
               LIMIT 10`,
            )
            .all(`"${safe.replace(/"/g, "")}"`) as Row[];
          targetIds = matched.map((r) => r.summary_id as string);
        }
      } else if (p.summaryIds && p.summaryIds.length > 0) {
        targetIds = p.summaryIds;
      }

      if (targetIds.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No summaries to expand. Provide summaryIds or query.",
            },
          ],
        };
      }

      // Expand each summary
      const expansions: Array<{
        summaryId: string;
        content: string;
        depth: number;
        kind: string;
        parents: string[];
        children: string[];
        messages: Array<{ id: string; role: string; seq: number; content: string }>;
      }> = [];

      for (const sid of targetIds.slice(0, 5)) {
        const expansion = expandSummaryDag(db, sid, maxDepth, includeMessages);
        if (expansion) {
          expansions.push(expansion);
        }
      }

      if (expansions.length === 0) {
        return { content: [{ type: "text", text: "No summaries found for the given criteria." }] };
      }

      // Format output
      const lines: string[] = [];
      const citedIds: string[] = [];
      let totalTokens = 0;

      for (const exp of expansions) {
        citedIds.push(exp.summaryId);
        const estimatedTokens = Math.ceil(exp.content.length / 4);
        totalTokens += estimatedTokens;

        lines.push(`=== ${exp.summaryId} (kind=${exp.kind}, depth=${exp.depth}, ~${estimatedTokens} tok) ===`);
        if (exp.parents.length > 0) {
          lines.push(`parents: ${exp.parents.join(", ")}`);
        }
        if (exp.children.length > 0) {
          lines.push(`children: ${exp.children.join(", ")}`);
        }
        lines.push("");
        lines.push(exp.content);
        lines.push("");

        if (exp.messages.length > 0) {
          lines.push(`--- Source messages (${exp.messages.length}) ---`);
          for (const msg of exp.messages) {
            const snippet = (msg.content ?? "").replace(/\n/g, " ").substring(0, 200);
            lines.push(`[${msg.role}] #${msg.seq} ${snippet}`);
          }
          lines.push("");
        }
      }

      lines.push(`---`);
      lines.push(
        `Expanded ${expansions.length} summaries, ${totalTokens} estimated tokens. Cited IDs: ${citedIds.join(", ")}`,
      );

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  DAG traversal                                                      */
/* ------------------------------------------------------------------ */

function expandSummaryDag(
  db: DatabaseSync,
  summaryId: string,
  maxDepth: number,
  includeMessages: boolean,
): {
  summaryId: string;
  content: string;
  depth: number;
  kind: string;
  parents: string[];
  children: string[];
  messages: Array<{ id: string; role: string; seq: number; content: string }>;
} | null {
  // Get the summary itself
  const summary = db.prepare("SELECT * FROM summaries WHERE summary_id = ?").get(summaryId) as
    | Row
    | undefined;
  if (!summary) return null;

  // Parents (what this summary was compacted from)
  const parentRows = db
    .prepare(
      `SELECT sp.parent_summary_id AS id, s.kind, s.depth, s.token_count
       FROM summary_parents sp
       LEFT JOIN summaries s ON sp.parent_summary_id = s.summary_id
       WHERE sp.summary_id = ?
       ORDER BY s.created_at`,
    )
    .all(summaryId) as Row[];
  const parents: string[] = parentRows.map((r) => r.id as string);

  // Children (what compacted this summary further)
  const childRows = db
    .prepare(
      `SELECT sp.summary_id AS id, s.kind, s.depth, s.token_count
       FROM summary_parents sp
       LEFT JOIN summaries s ON sp.summary_id = s.summary_id
       WHERE sp.parent_summary_id = ?
       ORDER BY s.created_at`,
    )
    .all(summaryId) as Row[];
  const children: string[] = childRows.map((r) => r.id as string);

  // Source messages
  let messages: Array<{ id: string; role: string; seq: number; content: string }> = [];

  if (includeMessages || (summary.depth as number) <= 1) {
    const msgRows = db
      .prepare(
        `SELECT m.message_id, m.role, m.seq, m.content
         FROM messages m
         JOIN summary_messages sm ON m.message_id = sm.message_id
         WHERE sm.summary_id = ?
         ORDER BY m.seq`,
      )
      .all(summaryId) as Row[];
    messages = msgRows.map((r) => ({
      id: r.message_id as string,
      role: r.role as string,
      seq: r.seq as number,
      content: (r.content as string) ?? "",
    }));
  }

  return {
    summaryId: summary.summary_id as string,
    content: summary.content as string,
    depth: summary.depth as number,
    kind: summary.kind as string,
    parents,
    children,
    messages,
  };
}
