// Schema extracted from lossless-claw/src/db/migration.ts
// Tables + indices. No OpenClaw-specific columns or session-key concepts.

export const CONTEXT_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  platform        TEXT NOT NULL,
  channel_id      TEXT NOT NULL DEFAULT '',
  active          INTEGER NOT NULL DEFAULT 1,
  archived_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  message_id      TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  content         TEXT,
  token_count     INTEGER,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  summary_id              TEXT PRIMARY KEY,
  conversation_id         TEXT NOT NULL REFERENCES conversations(conversation_id),
  kind                    TEXT NOT NULL CHECK(kind IN ('leaf','condensed')),
  depth                   INTEGER NOT NULL DEFAULT 0,
  content                 TEXT NOT NULL,
  token_count             INTEGER,
  descendant_count        INTEGER DEFAULT 0,
  descendant_token_count  INTEGER DEFAULT 0,
  source_message_token_count INTEGER,
  earliest_at             TEXT,
  latest_at               TEXT,
  model                   TEXT,
  created_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_items (
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  ordinal         INTEGER NOT NULL,
  item_type       TEXT NOT NULL CHECK(item_type IN ('message','summary')),
  message_id      TEXT,
  summary_id      TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (conversation_id, ordinal)
);

CREATE TABLE IF NOT EXISTS summary_messages (
  summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  PRIMARY KEY (summary_id, message_id)
);

CREATE TABLE IF NOT EXISTS summary_parents (
  summary_id        TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
  parent_summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
  PRIMARY KEY (summary_id, parent_summary_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);

CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  content,
  content='summaries',
  content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS message_parts (
  part_id       TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL,
  part_type     TEXT NOT NULL CHECK (part_type IN (
    'text', 'reasoning', 'tool', 'patch', 'file',
    'subtask', 'compaction', 'step_start', 'step_finish',
    'snapshot', 'agent', 'retry'
  )),
  ordinal       INTEGER NOT NULL,
  text_content  TEXT,
  is_ignored    INTEGER,
  is_synthetic  INTEGER,
  tool_call_id  TEXT,
  tool_name     TEXT,
  tool_status   TEXT,
  tool_input    TEXT,
  tool_output   TEXT,
  tool_error    TEXT,
  tool_title    TEXT,
  patch_hash    TEXT,
  patch_files   TEXT,
  file_mime     TEXT,
  file_name     TEXT,
  file_url      TEXT,
  subtask_prompt TEXT,
  subtask_desc  TEXT,
  subtask_agent TEXT,
  step_reason   TEXT,
  step_cost     REAL,
  step_tokens_in  INTEGER,
  step_tokens_out INTEGER,
  snapshot_hash TEXT,
  compaction_auto INTEGER,
  metadata      TEXT,
  UNIQUE (message_id, ordinal)
);

CREATE TABLE IF NOT EXISTS conversation_compaction_telemetry (
  conversation_id              TEXT PRIMARY KEY REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  last_observed_cache_read     INTEGER,
  last_observed_cache_write    INTEGER,
  last_observed_prompt_token_count INTEGER,
  last_observed_cache_hit_at   TEXT,
  last_observed_cache_break_at TEXT,
  cache_state                  TEXT NOT NULL DEFAULT 'unknown'
    CHECK (cache_state IN ('hot','cold','unknown')),
  consecutive_cold_observations INTEGER NOT NULL DEFAULT 0,
  retention                    TEXT,
  last_leaf_compaction_at      TEXT,
  turns_since_leaf_compaction  INTEGER NOT NULL DEFAULT 0,
  tokens_accumulated_since_leaf_compaction INTEGER NOT NULL DEFAULT 0,
  last_activity_band           TEXT NOT NULL DEFAULT 'low'
    CHECK (last_activity_band IN ('low','medium','high')),
  last_api_call_at             TEXT,
  last_cache_touch_at          TEXT,
  provider                     TEXT,
  model                        TEXT,
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_compaction_maintenance (
  conversation_id    TEXT PRIMARY KEY REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  pending            INTEGER NOT NULL DEFAULT 0,
  requested_at       TEXT,
  reason             TEXT,
  running            INTEGER NOT NULL DEFAULT 0,
  last_started_at    TEXT,
  last_finished_at   TEXT,
  last_failure_summary TEXT,
  token_budget       INTEGER,
  current_token_count INTEGER,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_summaries_conv ON summaries(conversation_id, depth);
CREATE INDEX IF NOT EXISTS idx_context_items_conv ON context_items(conversation_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_message_parts_msg ON message_parts(message_id);
CREATE INDEX IF NOT EXISTS idx_message_parts_type ON message_parts(part_type);
CREATE INDEX IF NOT EXISTS idx_message_parts_tool_call ON message_parts(tool_call_id);
`;

export function runMigrations(db: { exec: (sql: string) => void }): void {
  // Split on semicolons to work with both bun:sqlite and node:sqlite
  for (const stmt of CONTEXT_SCHEMA.split(';')) {
    const trimmed = stmt.trim();
    if (trimmed) {
      try {
        db.exec(trimmed + ';');
      } catch (error) {
        // FTS indexing/search is optional, but core storage must not start with
        // an incomplete schema after an unrelated migration failure.
        if (/^CREATE VIRTUAL TABLE IF NOT EXISTS (?:messages|summaries)_fts USING fts5\s*\(/i.test(trimmed)
          && error instanceof Error && error.message === 'no such module: fts5') continue;
        throw error;
      }
    }
  }
}
