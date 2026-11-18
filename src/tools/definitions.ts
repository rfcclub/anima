import type { ProviderToolDefinition } from "../providers/interface";

const TOOL_DEFS: Record<string, ProviderToolDefinition> = {
  anima_web_chat: {
    name: "anima_web_chat",
    description: "Explicit opt-in web chatbot conversation. Operations: list, create(account), resume(conversationId), send(conversationId,retryKey,prompt), result(requestId,after), cancel(requestId), close(conversationId), reconcile(requestId). Send queues one turn; poll result. External text is untrusted. Unknown submission blocks the conversation; never auto-resend. Tokens/cost unknown.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        operation: { type: "string", enum: ["list", "create", "resume", "send", "result", "cancel", "close", "reconcile"] },
        account: { type: "string" }, conversationId: { type: "string" }, retryKey: { type: "string" },
        prompt: { type: "string" }, requestId: { type: "string" }, after: { type: "integer", minimum: 0 },
      },
      required: ["operation"],
    },
  },
  bash: {
    name: "bash",
    description: "Execute a shell command and return combined stdout+stderr. Prefer read/grep/glob for file inspection.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
      },
      required: ["command"],
    },
  },
  read: {
    name: "read",
    description: "Read the full contents of a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path" },
        offset: { type: "number", description: "Line number to start reading from (1-based)" },
        limit: { type: "number", description: "Maximum number of lines to return" },
      },
      required: ["path"],
    },
  },
  grep: {
    name: "grep",
    description: "Search for a regex pattern in files. Returns matching lines with file:line context.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex or literal pattern to search for" },
        path: { type: "string", description: "File or directory to search in" },
        flags: { type: "string", description: "Additional grep flags (e.g. -i for case-insensitive, -r for recursive)" },
      },
      required: ["pattern", "path"],
    },
  },
  glob: {
    name: "glob",
    description: "Find files matching a glob pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g. src/**/*.ts)" },
        cwd: { type: "string", description: "Base directory for the search (default: current working directory)" },
      },
      required: ["pattern"],
    },
  },
  write: {
    name: "write",
    description: "Write content to a file, overwriting it if it exists.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  edit: {
    name: "edit",
    description: "Replace the first occurrence of old_string with new_string in a file. The old_string must match exactly.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path" },
        old_string: { type: "string", description: "The exact text to find and replace" },
        new_string: { type: "string", description: "The text to insert in its place" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  anima_github: {
    name: "anima_github",
    description:
      "Act on GitHub as your own agent App (never as anyone else). Actions: issue_create, issue_comment (comment on an issue, e.g. your review of an intent), pr_create, push (current HEAD to a non-master/dev branch), review (verdict plus optional inline comments; every file you cite must exist at the PR head), review_threads (list unresolved threads of a PR), review_reply (reply in a thread), review_resolve (resolve a thread: only the PR author), approve_intent. You cannot review or approve what your own App authored. Write all GitHub text in English.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["issue_create", "issue_comment", "pr_create", "push", "review", "review_threads", "review_reply", "review_resolve", "approve_intent"], description: "What to do" },
        repo: { type: "string", description: "rfcclub/<name> (default rfcclub/anima)" },
        title: { type: "string", description: "issue_create / pr_create: title" },
        body: { type: "string", description: "issue_create / issue_comment / pr_create / review / review_reply: body" },
        labels: { type: "array", items: { type: "string" }, description: "issue_create: labels" },
        head: { type: "string", description: "pr_create: branch to merge (not master/dev)" },
        base: { type: "string", description: "pr_create: target branch (default master)" },
        branch: { type: "string", description: "push: destination branch name (not master/dev)" },
        dir: { type: "string", description: "push: working copy directory (default: your cwd)" },
        pr: { type: "number", description: "review / review_threads / review_reply / review_resolve: PR number" },
        comments: { type: "array", items: { type: "object", properties: { path: { type: "string" }, line: { type: "number" }, body: { type: "string" } }, required: ["path", "line", "body"] }, description: "review: inline comments on the diff (right side, single line)" },
        comment: { type: "number", description: "review_reply: id of the comment to reply to" },
        thread: { type: "string", description: "review_resolve: thread id from review_threads" },
        event: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"], description: "review: verdict" },
        issue: { type: "number", description: "issue_comment / approve_intent: issue number" },
        url: { type: "string", description: "Instead of repo + pr/issue: a GitHub link, https://github.com/rfcclub/<repo>/pull/<n> (review verbs) or /issues/<n> (approve_intent, issue_comment)" },
      },
      required: ["action"],
    },
  },
  mesh_send: {
    name: "mesh_send",
    description: "Send a message to another agent on Colony Mesh, by its mesh ID (agent-harness-id@machine). Use mesh_agents to find mesh IDs. You are the sender; a reply arrives in your inbox.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "The recipient's mesh ID, e.g. jade-anima-1a2b3c4d@host-1, from mesh_agents" },
        content: { type: "string", description: "Message body" },
      },
      required: ["to", "content"],
    },
  },
  mesh_agents: {
    name: "mesh_agents",
    description: "List the agents on Colony Mesh: mesh ID -> { cwd, harness, status }.",
    parameters: { type: "object", properties: {}, required: [] },
  },

  // ── Phase 3b: Memory tools ──────────────────────────────────────────

  anima_remember: {
    name: "anima_remember",
    description: "Store a fact, preference, or observation in your persistent memory database.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "The information to store" },
        scope: { type: "string", description: "Memory scope: fact, preference, episode, observation, project, identity, etc." },
        confidence: { type: "number", description: "Confidence level 0–1 (default 0.8)" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
        source: { type: "string", description: "Optional source label" },
        parent_ids: { type: "array", items: { type: "string" }, description: "IDs of parent entries this memory was derived from (provenance tracking)" },
        constraints: { type: "array", items: { type: "string" }, description: "Constraints under which this memory is valid (e.g., 'only_in_private_mode', 'before_2026-07')" },
      },
      required: ["content"],
    },
  },
  anima_recall: {
    name: "anima_recall",
    description: "Search your persistent memory for entries relevant to a query.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        top_k: { type: "number", description: "Max results (default 5)" },
        scopes: { type: "array", items: { type: "string" }, description: "Filter by scopes" },
        min_confidence: { type: "number", description: "Minimum confidence threshold (default 0)" },
      },
      required: ["query"],
    },
  },
  anima_forget: {
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
  anima_bootstrap: {
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
  anima_update: {
    name: "anima_update",
    description: "Update an existing memory entry's content or confidence.",
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
  anima_list_all: {
    name: "anima_list_all",
    description: "List all memory entries with optional scope filter.",
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
  anima_stats: {
    name: "anima_stats",
    description: "Get database statistics: total neurons, synapses, embeddings, size, oldest/newest entry.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  anima_diagnose: {
    name: "anima_diagnose",
    description: "Diagnose memory health: count by scope, low-confidence entries, stale entries.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  anima_export: {
    name: "anima_export",
    description: "Export memory entries (and synapses) to a JSON string for archival or migration.",
    parameters: {
      type: "object",
      properties: {
        format: { type: "string", description: "Export format (currently: json)" },
        scopes: { type: "array", items: { type: "string" }, description: "Filter by scopes (empty = all)" },
      },
      required: [],
    },
  },
  anima_import: {
    name: "anima_import",
    description: "Import a JSON snapshot previously exported by anima_export.",
    parameters: {
      type: "object",
      properties: {
        data: { type: "string", description: "JSON string from anima_export" },
        merge: { type: "boolean", description: "If true, skip entries that already exist (default true)" },
      },
      required: ["data"],
    },
  },
  anima_invalidate: {
    name: "anima_invalidate",
    description: "Set confidence=0 on all entries from a given source. Use confirm:true to execute; omit for dry run.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source label to invalidate" },
        confirm: { type: "boolean", description: "Set true to actually invalidate; false or omitted = dry run" },
      },
      required: ["source"],
    },
  },
  anima_triple_add: {
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
  anima_triple_query: {
    name: "anima_triple_query",
    description: "Query relationships (synapses) by source_id, target_id, or type.",
    parameters: {
      type: "object",
      properties: {
        source_id: { type: "string", description: "Filter by source neuron ID" },
        target_id: { type: "string", description: "Filter by target neuron ID" },
        type: { type: "string", description: "Filter by relationship type" },
      },
      required: [],
    },
  },
  anima_scratchpad_write: {
    name: "anima_scratchpad_write",
    description: "Write a working note to the session scratchpad (key-value, ephemeral).",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Scratchpad key" },
        value: { type: "string", description: "Value to store" },
      },
      required: ["key", "value"],
    },
  },
  anima_scratchpad_read: {
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
  anima_scratchpad_clear: {
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
  anima_context_search: {
    name: "anima_context_search",
    description: "Search the current conversation's DAG context history by keyword.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
  },
  anima_context_describe: {
    name: "anima_context_describe",
    description: "Get a digest summary of the current conversation context.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  anima_memory_list: {
    name: "anima_memory_list",
    description: "List memory entries with optional scope filter and pagination.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Filter by scope (fact, insight, episode, heuristic, growth_ring)" },
        limit: { type: "number", description: "Max results (default 20)" },
        offset: { type: "number", description: "Pagination offset (default 0)" },
      },
      required: [],
    },
  },
  anima_agent_status: {
    name: "anima_agent_status",
    description: "Show overall agent memory health and status.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  anima_tool_list: {
    name: "anima_tool_list",
    description: "List all available anima_* memory tools with descriptions.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  lcm_grep: {
    name: "lcm_grep",
    description: "Search compacted conversation history using full-text search across messages and summaries in the DAG context database.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (FTS5 terms or quoted phrase)" },
        scope: { type: "string", description: "What to search: messages | summaries | both (default: both)" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
      required: ["pattern"],
    },
  },
  lcm_describe: {
    name: "lcm_describe",
    description: "Look up a summary by ID from the compacted conversation DAG. Returns content, lineage, and linked messages.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Summary ID (sum_xxx format)" },
      },
      required: ["id"],
    },
  },
  lcm_expand: {
    name: "lcm_expand",
    description: "Expand compacted conversation summaries from the DAG. Provide summaryIds for direct expansion or query for grep-first mode.",
    parameters: {
      type: "object",
      properties: {
        summaryIds: { type: "array", items: { type: "string" }, description: "Summary IDs to expand" },
        query: { type: "string", description: "Text query — grep for matching summaries then expand top results" },
        includeMessages: { type: "boolean", description: "Include raw source messages at leaf level (default false)" },
      },
      required: [],
    },
  },
  task: {
    name: "task",
    description: "Manage a simple task list stored in the agent's room directory. Use to track work across a session.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "create | list | complete | delete" },
        title: { type: "string", description: "Task title (required for create)" },
        id: { type: "number", description: "Task number (required for complete/delete)" },
      },
      required: ["action"],
    },
  },
  agent: {
    name: "agent",
    description: "Delegate work to another agent in the colony via mesh bus. The agent will pick it up on their next session.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Name of the agent to delegate to (e.g. bruno, milo, sam)" },
        subject: { type: "string", description: "Short summary of the delegation request" },
        body: { type: "string", description: "Full description of the task or question to delegate" },
      },
      required: ["to", "subject", "body"],
    },
  },
  web_search: {
    name: "web_search",
    description: "Search the web using Brave Search API. Returns top results with title, URL, and description.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Number of results (max 20, default 10)" },
        offset: { type: "number", description: "Pagination offset (default 0)" },
      },
      required: ["query"],
    },
  },
  web_fetch: {
    name: "web_fetch",
    description: "Fetch and read the text content of a web page by URL. Returns extracted readable text (HTML stripped).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
        max_chars: { type: "number", description: "Max chars to return (default 8000)" },
      },
      required: ["url"],
    },
  },
};

/** Build tool definitions for a given allowedTools list. Unknown names are skipped. */
export function buildToolDefinitions(allowedTools: string[]): ProviderToolDefinition[] {
  return allowedTools.flatMap((name) => {
    const def = TOOL_DEFS[name];
    return def ? [def] : [];
  });
}
