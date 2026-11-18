#!/usr/bin/env bash
# recall-agent.sh — recall from any ANIMA agent's memory.db (substrate-protocol, OMP/hook-callable)
# Generalized from eli-recall.sh. Usage:
#   recall-agent.sh <agent_name> "<query>" [--topK N]
#   recall-agent.sh eli "identity-runtime design"
#   recall-agent.sh sam "lease TTL" --topK 5
#
# Queries ~/.anima/agents/<agent_name>/memory.db. Uses FTS5 with OR semantics on whitespace-split
# tokens (more forgiving than the default AND), falls back to LIKE on failure.
# NOTE: this is the ~/.anima/agents/*/memory.db schema (UUID ids, FTS5 trigger) — NOT the
# bruno-entity schema (integer autoincrement ids, queried with its own recall.mjs). Do not point
# this script at an bruno-entity database.
set -euo pipefail

AGENT_NAME="${1:-}"
shift || true

if [[ -z "$AGENT_NAME" ]]; then
  echo '{"error":"missing_agent_name","usage":"recall-agent.sh <agent_name> \"<query>\" [--topK N]"}' >&2
  exit 1
fi

if [[ ! "$AGENT_NAME" =~ ^[a-z0-9_-]+$ ]]; then
  echo "{\"error\":\"invalid_agent_name\",\"agent_name\":\"$AGENT_NAME\"}" >&2
  exit 1
fi

DB="$HOME/.anima/agents/$AGENT_NAME/memory.db"
TOPK="${TOPK:-5}"

if [[ ! -f "$DB" ]]; then
  echo "{\"error\":\"db_not_found\",\"path\":\"$DB\",\"agent_name\":\"$AGENT_NAME\"}" >&2
  exit 1
fi

QUERY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --topK) TOPK="$2"; shift 2 ;;
    --topK=*) TOPK="${1#*=}"; shift ;;
    *) QUERY="$QUERY $1"; shift ;;
  esac
done

if [[ ! "$TOPK" =~ ^[0-9]+$ ]]; then
  echo "{\"error\":\"invalid_topK\",\"topK\":\"$TOPK\"}" >&2
  exit 1
fi

QUERY="${QUERY# }"
if [[ -z "$QUERY" ]]; then
  echo '{"error":"missing_query","usage":"recall-agent.sh <agent_name> \"<query>\" [--topK N]"}' >&2
  exit 1
fi

# Escape single quotes (SQL string-literal delimiter) for the LIKE fallback query below.
QUERY_ESC="${QUERY//\'/\'\'}"

# Build an FTS5 OR query: each whitespace token becomes "token" OR "token".
# Escape double-quotes per FTS5 string syntax.
FTS_QUERY=""
for tok in $QUERY; do
  esc=$(printf '%s' "$tok" | sed 's/"/""/g')
  if [[ -n "$FTS_QUERY" ]]; then FTS_QUERY="$FTS_QUERY OR "; fi
  FTS_QUERY="${FTS_QUERY}\"${esc}\""
done

# The FTS query is interpolated into a single-quoted SQL literal too: double any
# single quote so an apostrophe in a token doesn't close the literal early (which
# made this branch error out and silently degrade to the LIKE fallback below).
FTS_QUERY_ESC="${FTS_QUERY//\'/\'\'}"

# Try FTS5 OR-match first, fall back to LIKE substring match.
sqlite3 "$DB" -cmd ".mode json" "
SELECT n.id, n.type, n.scope, substr(n.content, 1, 400) AS preview, n.confidence, n.source, n.created_at
FROM neurons_fts f
JOIN neurons n ON n.rowid = f.rowid
WHERE neurons_fts MATCH '${FTS_QUERY_ESC}'
ORDER BY rank
LIMIT ${TOPK};" 2>/dev/null || \
sqlite3 "$DB" -cmd ".mode json" "
SELECT n.id, n.type, n.scope, substr(n.content, 1, 400) AS preview, n.confidence, n.source, n.created_at
FROM neurons n
WHERE n.content LIKE '%' || '${QUERY_ESC}' || '%'
ORDER BY n.created_at DESC
LIMIT ${TOPK};"
