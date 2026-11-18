/**
 * anima-memory-tools.ts — Full memory tool suite for OpenClaw adapter.
 *
 * Exports 19 tool factories mirroring the Hermes Python AnimaMemoryProvider
 * (hermes_plugin/anima_memory/provider.py) plus 2 context tools.
 * v2: Each factory receives a `getMemoryStore` async function that resolves
 * a standalone AnimaMemoryStore, independent of context engine lifecycle.
 */

import type { AnimaMemoryStore } from "../memory-store.js";
import type { AgentPluginState } from "../index.js";
import type { MemoryScope } from "../types.js";

interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string; items?: { type: string } }>;
    required: string[];
  };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

interface AnimaTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<ToolResult>;
}

/* ------------------------------------------------------------------ */
/*  Tool definitions                                                   */
/* ------------------------------------------------------------------ */

const TOOL_DEFS: ToolDef[] = [
  // ── Core memory ──
  {
    name: "anima_remember",
    description: "Store a fact, preference, or observation in your cross-platform memory database.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "The information to store" },
        scope: { type: "string", description: "Memory scope: fact, preference, observation, episode, decision, project, identity" },
        confidence: { type: "number", description: "Confidence level 0–1 (default 0.8)" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
        source: { type: "string", description: "Optional source label" },
      },
      required: ["content"],
    },
  },
  {
    name: "anima_recall",
    description: "Search your cross-platform memory for entries relevant to a query.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        top_k: { type: "number", description: "Max results (default 5)" },
        scope: { type: "string", description: "Filter by scope" },
        min_confidence: { type: "number", description: "Minimum confidence threshold" },
      },
      required: ["query"],
    },
  },
  {
    name: "anima_forget",
    description: "Remove a memory entry by ID.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Entry ID to remove" },
      },
      required: ["id"],
    },
  },
  {
    name: "anima_bootstrap",
    description: "Load top memories relevant to the current context for injection into reasoning.",
    parameters: {
      type: "object",
      properties: {
        max_entries: { type: "number", description: "Max entries to return (default 10)" },
        current_prompt: { type: "string", description: "Current user message for relevance scoring" },
      },
      required: [],
    },
  },
  {
    name: "anima_update",
    description: "Update an existing memory entry's content, confidence, or tags.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Entry ID to update" },
        content: { type: "string", description: "New content (optional)" },
        confidence: { type: "number", description: "New confidence (optional)" },
        tags: { type: "array", items: { type: "string" }, description: "New tags (optional)" },
      },
      required: ["id"],
    },
  },
  {
    name: "anima_memory_list",
    description: "List all memory entries with optional scope filter and pagination.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Filter by scope (optional)" },
        limit: { type: "number", description: "Max results (default 20)" },
        offset: { type: "number", description: "Pagination offset (default 0)" },
      },
      required: [],
    },
  },
  // ── Stats & diagnostics ──
  {
    name: "anima_stats",
    description: "Show memory statistics for your agent: total neurons, synapses, embeddings, DB size.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "anima_diagnose",
    description: "Run diagnostics on your memory database: count by scope, low-confidence entries, stale entries.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "anima_agent_status",
    description: "Show overall agent memory health and status.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  // ── Knowledge graph ──
  {
    name: "anima_triple_add",
    description: "Add a typed relationship (synapse) between two memory entries.",
    parameters: {
      type: "object",
      properties: {
        source_id: { type: "string", description: "ID of source neuron" },
        target_id: { type: "string", description: "ID of target neuron" },
        type: { type: "string", description: "Relationship type (e.g. causes, relates_to, contradicts)" },
        weight: { type: "number", description: "Relationship weight 0–1 (default 0.8)" },
      },
      required: ["source_id", "target_id", "type"],
    },
  },
  {
    name: "anima_triple_query",
    description: "Query relationships (synapses) for a memory entry.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory/neuron ID to query relationships for" },
      },
      required: ["id"],
    },
  },
  // ── Scratchpad ──
  {
    name: "anima_scratchpad_write",
    description: "Write a working note to the session scratchpad (key-value).",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Scratchpad key" },
        content: { type: "string", description: "Value to store" },
      },
      required: ["key", "content"],
    },
  },
  {
    name: "anima_scratchpad_read",
    description: "Read a value from the session scratchpad by key.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Scratchpad key" },
      },
      required: ["key"],
    },
  },
  {
    name: "anima_scratchpad_clear",
    description: "Clear one key from the scratchpad, or all keys if key is omitted.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to delete (omit to clear all)" },
      },
      required: [],
    },
  },
  // ── Import/Export ──
  {
    name: "anima_export",
    description: "Export all memories as a JSON string for archival or migration.",
    parameters: {
      type: "object",
      properties: {
        format: { type: "string", description: "Export format (default: json)" },
        scopes: { type: "array", items: { type: "string" }, description: "Filter by scopes" },
      },
      required: [],
    },
  },
  {
    name: "anima_import",
    description: "Import memories from a JSON array previously exported by anima_export.",
    parameters: {
      type: "object",
      properties: {
        entries: { type: "array", description: "Array of memory entry objects" },
        merge: { type: "boolean", description: "If true, skip entries that already exist (default true)" },
      },
      required: ["entries"],
    },
  },
  // ── Invalidate ──
  {
    name: "anima_invalidate",
    description: "Mark a memory entry as superseded (sets confidence to 0). Use confirm:true to execute.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory entry ID to invalidate" },
        reason: { type: "string", description: "Reason for invalidation" },
        confirm: { type: "boolean", description: "Set true to actually invalidate; false or omitted = dry run" },
      },
      required: ["id"],
    },
  },
  // ── Context engine (operates on context.db, not memory.db) ──
  {
    name: "anima_context_search",
    description: "Search conversation history using FTS5 across the DAG context database.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  // ── Consolidation ──
  {
    name: "anima_sleep",
    description: "Run memory consolidation — generate cross-session summary and clean up stale entries.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  // ── Context deep tools ──
  {
    name: "anima_context_describe",
    description: "Get a digest summary of the current conversation context.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "anima_context_expand",
    description: "Fetch full content of a specific DAG summary node by ID.",
    parameters: {
      type: "object",
      properties: {
        summary_id: { type: "string", description: "Summary node ID" },
      },
      required: ["summary_id"],
    },
  },
  // ── Meta ──
  {
    name: "anima_tool_list",
    description: "List all available anima_* memory tools.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

/* ------------------------------------------------------------------ */
/*  Handler                                                            */
/* ------------------------------------------------------------------ */

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Safely parse a JSON string, returning defaultValue on failure. */
function safeJsonParse<T>(raw: unknown, defaultValue: T): T {
  if (typeof raw !== "string") return defaultValue;
  try { return JSON.parse(raw) as T; } catch { return defaultValue; }
}

/* ------------------------------------------------------------------ */
/*  Exports                                                            */
/* ------------------------------------------------------------------ */

/**
 * Create all anima_* memory tool factories.
 * v2: Accepts an async getMemoryStore function that resolves a standalone
 * AnimaMemoryStore for the calling agent. No context engine required.
 * Also accepts optional getState for context-dependent tools.
 */
export function createAnimaMemoryTools(
  getMemoryStore: (agentId?: string) => Promise<AnimaMemoryStore>,
  getState?: () => AgentPluginState | null,
): AnimaTool[] {
  const toolMap: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
    anima_remember: async (args) => {
      const store = await getMemoryStore();
      const entry = await store.remember({
        content: String(args.content ?? ""),
        scope: ((args.scope as string) ?? "fact") as MemoryScope,
        confidence: typeof args.confidence === "number" ? args.confidence : 0.8,
        tags: Array.isArray(args.tags) ? (args.tags as any) : [],
        source: String(args.source ?? "openclaw"),
      });
      return jsonResult({ id: entry.id, created_at: entry.createdAt });
    },

    anima_recall: async (args) => {
      const store = await getMemoryStore();
      const entries = await store.recall(String(args.query ?? ""), {
        topK: typeof args.top_k === "number" ? args.top_k : 5,
        scopes: (args.scope ? [args.scope] as any : undefined),
        minConfidence: typeof args.min_confidence === "number" ? args.min_confidence : undefined,
      });
      return jsonResult((entries as any[]).map((e: any) => ({
        id: e.id, content: e.content, scope: e.scope, confidence: e.confidence,
        tags: e.tags, source: e.source, created_at: e.createdAt,
      })));
    },

    anima_forget: async (args) => {
      const store = await getMemoryStore();
      await store.forget(String(args.id ?? ""));
      return jsonResult({ status: "ok" });
    },

    anima_bootstrap: async (args) => {
      const store = await getMemoryStore();
      const entries = await store.bootstrap({
        maxEntries: typeof args.max_entries === "number" ? args.max_entries : 10,
      });
      return jsonResult((entries as any[]).map((e: any) => ({ id: e.id, content: e.content, scope: e.scope })));
    },

    anima_update: async (args) => {
      const store = await getMemoryStore();
      const id = String(args.id ?? "");
      const db = store.getDb();
      if (!db) throw new Error("Database not available");
      const updates: string[] = [];
      const values: unknown[] = [];
      if (args.content !== undefined) { updates.push("content = ?"); values.push(String(args.content)); }
      if (args.confidence !== undefined) { updates.push("confidence = ?"); values.push(Number(args.confidence)); }
      if (args.tags !== undefined) { updates.push("tags = ?"); values.push(JSON.stringify(args.tags)); }
      if (updates.length === 0) return jsonResult({ status: "ok", id, message: "no changes" });
      updates.push("updated_at = ?");
      values.push(new Date().toISOString());
      values.push(id);
      db.prepare(`UPDATE neurons SET ${updates.join(", ")} WHERE id = ?`).run(...values as any[]);
      return jsonResult({ status: "ok", id });
    },

    anima_memory_list: async (args) => {
      const store = await getMemoryStore();
      const scope = args.scope ? String(args.scope) : null;
      const limit = typeof args.limit === "number" ? args.limit : 20;
      const offsetN = typeof args.offset === "number" ? args.offset : 0;
      if (scope) {
        const entries = await store.recall(scope, { topK: limit, scopes: [scope] as any });
        return jsonResult((entries as any[]).slice(offsetN, offsetN + limit).map((e: any) => ({
          id: e.id, content: e.content, scope: e.scope, confidence: e.confidence,
          tags: e.tags, source: e.source, created_at: e.createdAt,
        })));
      }
      const db = store.getDb();
      const rows = db.prepare("SELECT * FROM neurons ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offsetN) as any[];
      return jsonResult(rows.map((r: any) => ({
        id: r.id, content: r.content, scope: r.scope || r.type || "fact",
        confidence: r.confidence ?? 0.5, tags: safeJsonParse(r.tags, []),
        source: r.source ?? "unknown", created_at: r.created_at,
      })));
    },

    anima_stats: async (_args) => {
      const store = await getMemoryStore();
      return jsonResult(store.getStats());
    },

    anima_diagnose: async (_args) => {
      const store = await getMemoryStore();
      return jsonResult(store.diagnose());
    },

    anima_agent_status: async (_args) => {
      const store = await getMemoryStore();
      const stats = store.getStats();
      return jsonResult({ memory_db: store.getDbPath(), ...stats, healthy: true });
    },

    anima_triple_add: async (args) => {
      const store = await getMemoryStore();
      const db = store.getDb();
      if (!db) throw new Error("Database not available");
      const sid = String(args.source_id ?? "");
      const tid = String(args.target_id ?? "");
      const stmt = db.prepare("SELECT id FROM neurons WHERE id = ?");
      if (!stmt.get(sid)) return jsonResult({ status: "error", message: `source neuron not found: ${sid}` });
      if (!stmt.get(tid)) return jsonResult({ status: "error", message: `target neuron not found: ${tid}` });
      const { randomUUID } = await import("node:crypto");
      const id = randomUUID();
      db.prepare("INSERT INTO synapses (id, source_id, target_id, type, weight, metadata) VALUES (?, ?, ?, ?, ?, ?)").run(
        id, sid, tid, String(args.type ?? "relates_to"), typeof args.weight === "number" ? args.weight : 0.8, "{}",
      );
      return jsonResult({ synapse_id: id, status: "ok" });
    },

    anima_triple_query: async (args) => {
      const store = await getMemoryStore();
      const db = store.getDb();
      if (!db) throw new Error("Database not available");
      const neuronId = String(args.id ?? "");
      const synapses = db.prepare(
        `SELECT s.*, n.content as source_content, n2.content as target_content
         FROM synapses s LEFT JOIN neurons n ON s.source_id = n.id
         LEFT JOIN neurons n2 ON s.target_id = n2.id
         WHERE s.source_id = ? OR s.target_id = ?`,
      ).all(neuronId, neuronId) as Record<string, unknown>[];
      return jsonResult(synapses);
    },

    anima_scratchpad_write: async (args) => {
      const store = await getMemoryStore();
      store.scratchpadSet(String(args.key ?? ""), String(args.content ?? ""));
      return jsonResult({ status: "ok", key: args.key });
    },

    anima_scratchpad_read: async (args) => {
      const store = await getMemoryStore();
      return jsonResult(store.scratchpadGet(String(args.key ?? "")));
    },

    anima_scratchpad_clear: async (args) => {
      const store = await getMemoryStore();
      const deleted = store.scratchpadDelete(args.key ? String(args.key) : undefined);
      return jsonResult({ status: "ok", deleted });
    },

    anima_export: async (args) => {
      const store = await getMemoryStore();
      const scopes = Array.isArray(args.scopes) ? (args.scopes as string[]) : null;
      const db = store.getDb();
      let rows: any[];
      if (scopes && scopes.length > 0) {
        const placeholders = scopes.map(() => "?").join(",");
        rows = db.prepare(`SELECT * FROM neurons WHERE scope IN (${placeholders}) ORDER BY created_at DESC`).all(...scopes) as any[];
      } else {
        rows = db.prepare("SELECT * FROM neurons ORDER BY created_at DESC").all() as any[];
      }
      const entries = rows.map((r: any) => ({
        id: r.id, content: r.content, scope: r.scope || r.type || "fact",
        confidence: r.confidence ?? 0.5, tags: safeJsonParse(r.tags, []),
        source: r.source ?? "unknown", created_at: r.created_at, updated_at: r.updated_at,
      }));
      return jsonResult(entries);
    },

    anima_import: async (args) => {
      const store = await getMemoryStore();
      const entries = (Array.isArray(args.entries) ? args.entries : []) as Array<Record<string, unknown>>;
      let imported = 0; let skipped = 0;
      for (const e of entries) {
        const exists = e.id ? await store.recall(String(e.id), { topK: 1 }) : [];
        if (exists.length > 0 && args.merge !== false) { skipped++; continue; }
        await store.remember({
          content: String(e.content ?? ""),
          scope: (e.scope as any) ?? "fact",
          confidence: typeof e.confidence === "number" ? e.confidence : 0.8,
          tags: Array.isArray(e.tags) ? (e.tags as string[]) : [],
          source: String(e.source ?? "import"),
        });
        imported++;
      }
      return jsonResult({ imported, skipped });
    },

    anima_invalidate: async (args) => {
      const store = await getMemoryStore();
      const id = String(args.id ?? "");
      if (!args.confirm) return jsonResult({ dry_run: true, id, message: "Set confirm: true to execute" });
      const db = store.getDb();
      if (!db) throw new Error("Database not available");
      db.prepare("UPDATE neurons SET confidence = 0, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      return jsonResult({ status: "ok", id, confidence: 0 });
    },

    // Context-dependent tools — require context engine state
    anima_context_search: async (args) => {
      if (!getState) throw new Error("Context engine not available. Requires contextEngine: 'anima'.");
      const state = getState();
      if (!state) throw new Error("Context engine not initialized. Requires contextEngine: 'anima'.");
      const results = await state.adapter.search(String(args.query ?? ""), { limit: typeof args.limit === "number" ? args.limit : 10 });
      return jsonResult(results);
    },

    anima_sleep: async (_args) => {
      if (!getState) throw new Error("Context engine not available. Requires contextEngine: 'anima'.");
      const state = getState();
      if (!state) throw new Error("Context engine not initialized. Requires contextEngine: 'anima'.");
      const db = state.adapter.getDb();
      if (!db) throw new Error("Database not available");
      const conversations = db.prepare("SELECT DISTINCT conversation_id FROM messages").all() as Array<{ conversation_id: number }>;
      let compacted = 0;
      for (const conv of conversations) {
        try { await state.adapter.compact({ conversationId: String(conv.conversation_id) }); compacted++; } catch { /* skip */ }
      }
      const store = await getMemoryStore();
      await store.remember({
        content: `Consolidation: compacted ${compacted} conversation(s)`,
        scope: "episode", tags: ["consolidation", "openclaw"],
        confidence: 0.7, source: "anima_sleep",
      });
      return jsonResult({ status: "ok", compacted_conversations: compacted });
    },

    anima_context_describe: async (_args) => {
      if (!getState) throw new Error("Context engine not available. Requires contextEngine: 'anima'.");
      const state = getState();
      if (!state) throw new Error("Context engine not initialized. Requires contextEngine: 'anima'.");
      try {
        const assembled = await state.adapter.assemble({ prompt: "summarize", tokenBudget: 2000 } as any);
        return textResult(assembled?.systemPromptAddition ?? "(no context assembled yet)");
      } catch { return textResult("(context describe failed)"); }
    },

    anima_context_expand: async (args) => {
      if (!getState) throw new Error("Context engine not available. Requires contextEngine: 'anima'.");
      const state = getState();
      if (!state) throw new Error("Context engine not initialized. Requires contextEngine: 'anima'.");
      const db = state.adapter.getDb();
      if (!db) throw new Error("Database not available");
      const summaryId = String(args.summary_id ?? "");
      const s = db.prepare("SELECT * FROM summaries WHERE summary_id = ?").get(summaryId) as Record<string, unknown> | undefined;
      if (!s) return jsonResult({ status: "error", message: `summary not found: ${summaryId}` });
      const parents = db.prepare("SELECT parent_summary_id FROM summary_parents WHERE child_summary_id = ?").all(summaryId);
      const messages = db.prepare("SELECT m.* FROM messages m JOIN summary_messages sm ON m.id = sm.message_id WHERE sm.summary_id = ?").all(summaryId);
      return jsonResult({ summary: s, parents, messages });
    },

    anima_tool_list: async (_args) => {
      return jsonResult({ total_tools: TOOL_DEFS.length, tools: TOOL_DEFS.map((d) => ({ name: d.name, description: d.description })) });
    },
  };

  return TOOL_DEFS.map((def) => ({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: async (_toolCallId: string, params: unknown) => {
      const handler = toolMap[def.name];
      if (!handler) return textResult(`Unknown tool: ${def.name}`);
      try {
        return await handler((params ?? {}) as Record<string, unknown>);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return jsonResult({ status: "error", message: msg });
      }
    },
  }));
}

/** Export just the tool names for reference */
export const ANIMA_MEMORY_TOOL_NAMES = TOOL_DEFS.map((d) => d.name);
