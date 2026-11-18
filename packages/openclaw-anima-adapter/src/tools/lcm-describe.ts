/**
 * lcm_describe — Summary detail lookup
 *
 * SELECT from summaries by id, with optional DAG parent/child expansion.
 * Operates directly against context.db using node:sqlite.
 */

import { DatabaseSync } from "node:sqlite";
import type { AnimaTool } from "../types.js";

/* ------------------------------------------------------------------ */
/*  Schema                                                             */
/* ------------------------------------------------------------------ */

interface LcmDescribeParams {
  id: string;
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

export function createLcmDescribeTool(getDb: () => DatabaseSync | null): AnimaTool {
  return {
    name: "lcm_describe",
    description:
      "Look up metadata and content for a summary by ID (sum_xxx) from compacted conversation history. " +
      "Returns summary content, lineage, parent/child relationships, and token counts.",

    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The summary ID to look up (sum_xxx format).",
        },
        conversationId: {
          type: "string",
          description: "Conversation ID to scope the lookup. If omitted, searches all.",
        },
        allConversations: {
          type: "boolean",
          description: "Set true to allow cross-conversation lookup.",
        },
      },
      required: ["id"],
    },

    async execute(_toolCallId: string, params: unknown) {
      const db = getDb();
      if (!db) {
        throw new Error("Anima context engine database is unavailable.");
      }

      const p = params as LcmDescribeParams;
      const id = p.id?.trim() ?? "";
      if (!id) {
        return { content: [{ type: "text", text: "No summary ID provided." }] };
      }

      // Fetch the summary
      const summary = db.prepare("SELECT * FROM summaries WHERE summary_id = ?").get(id) as
        | Row
        | undefined;
      if (!summary) {
        return { content: [{ type: "text", text: `Not found: ${id}` }] };
      }

      const conversationId = summary.conversation_id as string;

      // Scope check
      const requestedConv = p.conversationId?.trim();
      if (requestedConv && conversationId !== requestedConv) {
        return {
          content: [
            {
              type: "text",
              text: `Not found in this conversation scope: ${id}. Use allConversations=true for cross-conversation lookup.`,
            },
          ],
        };
      }

      // Fetch parent summaries
      const parents = db
        .prepare(
          `SELECT s.summary_id, s.kind, s.depth, s.token_count, s.created_at
           FROM summaries s
           JOIN summary_parents sp ON s.summary_id = sp.parent_summary_id
           WHERE sp.summary_id = ?
           ORDER BY s.created_at`,
        )
        .all(id) as Row[];

      // Fetch child summaries
      const children = db
        .prepare(
          `SELECT s.summary_id, s.kind, s.depth, s.token_count, s.created_at
           FROM summaries s
           JOIN summary_parents sp ON s.summary_id = sp.summary_id
           WHERE sp.parent_summary_id = ?
           ORDER BY s.created_at`,
        )
        .all(id) as Row[];

      // Fetch linked messages
      const messages = db
        .prepare(
          `SELECT m.message_id, m.role, m.seq, m.token_count, m.created_at
           FROM messages m
           JOIN summary_messages sm ON m.message_id = sm.message_id
           WHERE sm.summary_id = ?
           ORDER BY m.seq`,
        )
        .all(id) as Row[];

      // Format output
      const lines: string[] = [];
      lines.push(`LCM_SUMMARY ${id}`);
      lines.push(
        `meta conv=${conversationId} kind=${summary.kind} depth=${summary.depth} tok=${summary.token_count} descTok=${summary.descendant_token_count ?? 0} srcTok=${summary.source_message_token_count ?? 0} desc=${summary.descendant_count ?? 0}`,
      );
      if (parents.length > 0) {
        lines.push(`parents ${parents.map((p) => p.summary_id).join(" ")}`);
      }
      if (children.length > 0) {
        lines.push(`children ${children.map((c) => c.summary_id).join(" ")}`);
      }
      if (messages.length > 0) {
        lines.push(`source_messages ${messages.length}`);
        for (const msg of messages) {
          lines.push(
            `  ${msg.message_id} role=${msg.role} seq=${msg.seq} tok=${msg.token_count ?? "?"} ts=${formatDisplayTime(msg.created_at as string)}`,
          );
        }
      }
      lines.push("");
      lines.push("content");
      lines.push(summary.content as string);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  };
}

function formatDisplayTime(value: string | null | undefined): string {
  if (!value) return "-";
  try {
    return new Date(value).toISOString();
  } catch {
    return "-";
  }
}
