#!/usr/bin/env bash
# eli-recall.sh — recall from Eli's anima memory.db (substrate-protocol, OMP-callable)
# Usage: eli-recall.sh "<query>" [--topK N]
#   eli-recall.sh "identity-runtime design"
#   eli-recall.sh "lease TTL" --topK 5
#
# Queries ~/.anima/agents/eli/memory.db. Uses FTS5 with OR semantics on whitespace-split
# tokens (more forgiving than the default AND), falls back to LIKE on failure.
set -euo pipefail

DB="$HOME/.anima/agents/eli/memory.db"
TOPK="${TOPK:-5}"

if [[ ! -f "$DB" ]]; then
  echo "{\"error\":\"db_not_found\",\"path\":\"$DB\"}" >&2
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

QUERY="${QUERY# }"
if [[ -z "$QUERY" ]]; then
  echo '{"error":"missing_query","usage":"eli-recall.sh \"<query>\" [--topK N]"}' >&2
  exit 1
fi

# TOPK is interpolated into SQL — digits only (same guard as recall-agent.sh).
if [[ ! "$TOPK" =~ ^[0-9]+$ ]]; then
  echo '{"error":"invalid_topK"}' >&2
  exit 1
fi

# Build an FTS5 OR query: each whitespace token becomes "token" OR "token".
# Escape double-quotes per FTS5 string syntax.
FTS_QUERY=""
for tok in $QUERY; do
  esc=$(printf '%s' "$tok" | sed 's/"/""/g')
  if [[ -n "$FTS_QUERY" ]]; then FTS_QUERY="$FTS_QUERY OR "; fi
  FTS_QUERY="${FTS_QUERY}\"${esc}\""
done

# Both queries are interpolated into single-quoted SQL literals: double any
# single quote (SQL's escape) so user text can't close the literal early.
FTS_QUERY_ESC="${FTS_QUERY//\'/\'\'}"
QUERY_ESC="${QUERY//\'/\'\'}"

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
