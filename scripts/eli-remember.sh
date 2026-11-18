#!/usr/bin/env bash
# eli-remember.sh — write one neuron to Eli's anima memory.db (substrate-protocol, OMP-callable)
# Usage: eli-remember.sh --content "<text>" --scope <scope> [--type episode] [--confidence 0.8] [--tags a,b] [--source eli-omp]
#   eli-remember.sh --content "the user dislikes over-engineered pilots" --scope preference --type preference --confidence 0.9
#
# Writes one row to neurons (FTS auto-indexed via trigger). Does NOT touch continuity.db
# — this is a direct substrate write for the OMP host path. Lease/scope enforcement is
# the anima tool layer's job; this bypasses it (OMP is a trusted host, not an agent turn).
set -euo pipefail

DB="$HOME/.anima/agents/eli/memory.db"

if [[ ! -f "$DB" ]]; then
  echo "{\"error\":\"db_not_found\",\"path\":\"$DB\"}" >&2
  exit 1
fi

CONTENT=""
TYPE="episode"
SCOPE="observation"
CONFIDENCE="0.8"
TAGS="[]"
SOURCE="eli-omp"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --content) CONTENT="$2"; shift 2 ;;
    --type) TYPE="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --confidence) CONFIDENCE="$2"; shift 2 ;;
    --tags) TAGS="[$(echo "$2" | sed 's/[^,]*/"&"/g')]"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --help|-h)
      echo "eli-remember.sh --content \"<text>\" --scope <s> [--type episode] [--confidence 0.8] [--tags a,b] [--source eli-omp]"
      exit 0 ;;
    *) echo "{\"error\":\"unknown_arg\",\"arg\":\"$1\"}" >&2; exit 1 ;;
  esac
done

if [[ -z "$CONTENT" ]]; then
  echo '{"error":"missing_required_field","field":"content"}' >&2
  exit 1
fi

# CONFIDENCE is interpolated unquoted into SQL — numeric only (same guard as remember-agent.sh).
if [[ ! "$CONFIDENCE" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  echo "{\"error\":\"invalid_confidence\",\"confidence\":\"$CONFIDENCE\"}" >&2
  exit 1
fi

UUID=$(uuidgen | tr 'A-Z' 'a-z')
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
META="{\"source\":\"${SOURCE}\",\"written_by\":\"eli-omp\"}"

# Escape single quotes (SQL string-literal delimiter) in every field interpolated below.
CONTENT_ESC="${CONTENT//\'/\'\'}"
TYPE_ESC="${TYPE//\'/\'\'}"
META_ESC="${META//\'/\'\'}"
SCOPE_ESC="${SCOPE//\'/\'\'}"
TAGS_ESC="${TAGS//\'/\'\'}"
SOURCE_ESC="${SOURCE//\'/\'\'}"

sqlite3 "$DB" -cmd ".mode json" "
INSERT INTO neurons (id, type, content, metadata, access_count, created_at, updated_at, scope, tags, source, confidence)
VALUES ('${UUID}', '${TYPE_ESC}', '${CONTENT_ESC}', '${META_ESC}', 0, '${NOW}', '${NOW}', '${SCOPE_ESC}', '${TAGS_ESC}', '${SOURCE_ESC}', ${CONFIDENCE});
SELECT '${UUID}' AS neuron_id, '${TYPE_ESC}' AS type, '${SCOPE_ESC}' AS scope, '${NOW}' AS created_at;" 2>&1

echo "{\"ok\":true,\"neuron_id\":\"${UUID}\",\"type\":\"${TYPE}\",\"scope\":\"${SCOPE}\",\"content_preview\":\"${CONTENT:0:120}\",\"source\":\"${SOURCE}\",\"db\":\"${DB}\"}"
