#!/usr/bin/env bash
# check-consistency.sh — validate SCENT residues against MEMORY.md.
#
# SCENT residues are the short "# topic: text" lines in BLADE/SCENT/*.md.
# MEMORY.md records the same topics as "- topic: text" entries. This script
# reads both and reports, for every residue:
#
#   missing  — MEMORY.md has no entry for that topic at all
#   diverged — MEMORY.md has an entry, but it does not contain the residue text
#
# Detection and report only: MEMORY.md is never written by this script.
#
# Usage: bash check-consistency.sh
#   BLADE_DIR    BLADE root (default ~/agora/familia/abel/BLADE)
#   MEMORY_FILE  MEMORY.md to validate against (default ~/agora/familia/abel/MEMORY.md)
#   SCENT_DIR    residue directory (default $BLADE_DIR/SCENT)
#   REPORT_FILE  report destination (default $BLADE_DIR/consistency-report.md)
#
# Exit codes: 0 clean, 1 mismatches found, 2 input error.
# The report is overwritten on every run.

set -euo pipefail

BLADE_DIR="${BLADE_DIR:-$HOME/agora/familia/abel/BLADE}"
MEMORY_FILE="${MEMORY_FILE:-$HOME/agora/familia/abel/MEMORY.md}"
SCENT_DIR="${SCENT_DIR:-$BLADE_DIR/SCENT}"
REPORT_FILE="${REPORT_FILE:-$BLADE_DIR/consistency-report.md}"

die() {
  echo "check-consistency: $*" >&2
  exit 2
}

[[ -f "$MEMORY_FILE" ]] || die "MEMORY.md not found: $MEMORY_FILE"

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Find the MEMORY.md entry for a topic. Sets MEM_LINE and MEM_TEXT (empty when
# the topic was never recorded).
memory_lookup() {
  local topic="$1" line body n=0
  MEM_LINE=""
  MEM_TEXT=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    body="$(trim "$line")"
    [[ "$body" == [-*]\ * ]] || continue
    body="$(trim "${body:2}")"
    if [[ "$body" == "$topic:"* ]]; then
      MEM_LINE="$n"
      MEM_TEXT="$(trim "${body#"$topic:"}")"
      return 0
    fi
  done < "$MEMORY_FILE"
}

mismatch_count=0
details=()

shopt -s nullglob
residue_files=("$SCENT_DIR"/*.md)
shopt -u nullglob

for file in ${residue_files[@]+"${residue_files[@]}"}; do
  [[ -f "$file" ]] || continue
  base="$(basename "$file")"
  n=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    body="$(trim "$line")"
    [[ "$body" == "# "* ]] || continue
    body="$(trim "${body:2}")"
    [[ "$body" == *:* ]] || continue
    topic="$(trim "${body%%:*}")"
    residue="$(trim "${body#*:}")"
    [[ -n "$topic" && -n "$residue" ]] || continue

    memory_lookup "$topic"

    kind=""
    if [[ -z "$MEM_LINE" ]]; then
      kind="missing"
    elif [[ "$MEM_TEXT" != *"$residue"* ]]; then
      kind="diverged"
    fi
    [[ -n "$kind" ]] || continue

    mismatch_count=$((mismatch_count + 1))
    details+=("- [$kind] \`$topic\` — SCENT/$base:$n")
    details+=("  - residue: $residue")
    if [[ "$kind" == "missing" ]]; then
      details+=("  - memory: no \`$topic\` entry in MEMORY.md")
    else
      details+=("  - memory: $(basename "$MEMORY_FILE"):$MEM_LINE: $MEM_TEXT")
    fi
    details+=("")
  done < "$file"
done

mkdir -p "$(dirname "$REPORT_FILE")"

{
  echo "# SCENT consistency report"
  echo
  echo "- Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "- SCENT: $SCENT_DIR"
  echo "- MEMORY.md: $MEMORY_FILE"
  echo
  echo "Mismatches: $mismatch_count"
  echo
  if [[ "$mismatch_count" -eq 0 ]]; then
    echo "No mismatches: every SCENT residue is recorded in MEMORY.md."
  else
    printf '%s\n' "${details[@]}"
  fi
} > "$REPORT_FILE"

echo "Mismatches: $mismatch_count — report: $REPORT_FILE"
[[ "$mismatch_count" -eq 0 ]] || exit 1
exit 0
