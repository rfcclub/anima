#!/usr/bin/env bash
# check-consistency.sh — validate SCENT residues against MEMORY.md.
#
# SCENT residues are the short "# topic: text" lines in BLADE/SCENT/*.md.
# MEMORY.md records the same topics as "- topic: text" entries. This script
# reads both and reports, for every residue:
#
#   missing  — MEMORY.md has no entry for that topic at all
#   diverged — MEMORY.md has entries for that topic, but none of them starts
#              with the residue text (matched at a whole-word boundary: the
#              residue may be extended by MEMORY.md, so "held em stance" is
#              consistent with "held em stance through the review", while
#              "done" is not consistent with "not done")
#
# Every MEMORY.md entry for the topic is considered, so a residue that matches
# a later duplicate entry is not reported. Divergences list all of the topic's
# entries so each one can be checked by hand.
#
# Known limitation: because MEMORY.md may extend a residue, a residue that is
# itself the negated part of an entry is not detected. Residue "deploy:
# approved" is consistent with "deploy: approved? no, rejected", and "done"
# with "done not". Only an entry that negates before or within the residue text
# ("not done") is reported.
#
# Detection and report only: MEMORY.md and the SCENT residues are never
# written by this script. REPORT_FILE is rejected (exit 2) when it resolves to
# MEMORY_FILE or inside SCENT_DIR, and when it is the same file as MEMORY.md or
# a residue (symlink or hardlink).
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
[[ -d "$SCENT_DIR" && -r "$SCENT_DIR" ]] ||
  die "SCENT directory not found or unreadable: $SCENT_DIR"

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Follow a chain of symlinks without depending on GNU/BSD realpath flags.
resolve_symlinks() {
  local p="$1" target hops=0
  while [[ -L "$p" ]]; do
    hops=$((hops + 1))
    [[ "$hops" -le 40 ]] || return 1
    target="$(readlink "$p")"
    case "$target" in
      /*) p="$target" ;;
      *) p="$(dirname "$p")/$target" ;;
    esac
  done
  printf '%s' "$p"
}

# Absolute, symlink-free path for a file that may not exist yet: resolve the
# file's symlinks, then resolve its nearest existing ancestor directory.
canonical_path() {
  local path dir base suffix=""
  path="$(resolve_symlinks "$1")" || return 1
  dir="$(dirname "$path")"
  base="$(basename "$path")"
  while [[ ! -d "$dir" ]]; do
    [[ -z "$dir" || "$dir" == "." || "$dir" == "/" ]] && break
    suffix="/$(basename "$dir")$suffix"
    dir="$(dirname "$dir")"
  done
  dir="$(cd "$dir" 2>/dev/null && pwd -P)" || return 1
  printf '%s%s/%s' "${dir%/}" "$suffix" "$base"
}

memory_canon="$(canonical_path "$MEMORY_FILE")" || die "cannot resolve MEMORY.md: $MEMORY_FILE"
scent_canon="$(canonical_path "$SCENT_DIR")" || die "cannot resolve SCENT: $SCENT_DIR"
report_canon="$(canonical_path "$REPORT_FILE")" ||
  die "cannot resolve report destination: $REPORT_FILE"

[[ "$report_canon" != "$memory_canon" ]] ||
  die "REPORT_FILE must not be MEMORY.md: $REPORT_FILE"

if [[ "$report_canon" == "$scent_canon" || "$report_canon" == "$scent_canon"/* ]]; then
  die "REPORT_FILE must not be inside the SCENT directory: $REPORT_FILE"
fi

# Path comparison misses hardlinks and case-insensitive aliases, which are the
# same file with different names. Compare inodes instead, and only when the
# report already exists: -ef is a filesystem identity check.
if [[ -e "$REPORT_FILE" ]]; then
  [[ ! "$REPORT_FILE" -ef "$MEMORY_FILE" ]] ||
    die "REPORT_FILE must not be the same file as MEMORY.md: $REPORT_FILE"
  shopt -s nullglob
  existing_residues=("$SCENT_DIR"/*.md)
  shopt -u nullglob
  for residue_file in ${existing_residues[@]+"${existing_residues[@]}"}; do
    [[ -f "$residue_file" ]] || continue
    [[ ! "$REPORT_FILE" -ef "$residue_file" ]] ||
      die "REPORT_FILE must not be the same file as SCENT residue: $residue_file"
  done
  unset existing_residues residue_file
fi

# Find every MEMORY.md entry for a topic. Sets MEM_LINES and MEM_TEXTS (empty
# when the topic was never recorded).
memory_lookup() {
  local topic="$1" line body n=0
  MEM_LINES=()
  MEM_TEXTS=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    body="$(trim "$line")"
    [[ "$body" == [-*]\ * ]] || continue
    body="$(trim "${body:2}")"
    if [[ "$body" == "$topic:"* ]]; then
      MEM_LINES+=("$n")
      MEM_TEXTS+=("$(trim "${body#"$topic:"}")")
    fi
  done < "$MEMORY_FILE"
}

# A residue is consistent with a MEMORY.md entry when it equals the entry text
# or is a whole-word prefix of it. Substring containment is deliberately not
# enough: residue "done" must not pass against "not done".
residue_matches() {
  local mem="$1" residue="$2"
  mem="${mem#"${mem%%[![:space:]]*}"}"
  mem="${mem%"${mem##*[![:space:]]}"}"
  [[ "$mem" == "$residue" ]] && return 0
  [[ "$mem" == "$residue"* ]] || return 1
  mem="${mem#"$residue"}"
  [[ "$mem" == [[:space:][:punct:]]* ]]
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
    if [[ "${#MEM_LINES[@]}" -eq 0 ]]; then
      kind="missing"
    else
      matched=""
      for mem_text in "${MEM_TEXTS[@]}"; do
        if residue_matches "$mem_text" "$residue"; then
          matched=1
          break
        fi
      done
      [[ -n "$matched" ]] || kind="diverged"
    fi
    [[ -n "$kind" ]] || continue

    mismatch_count=$((mismatch_count + 1))
    details+=("- [$kind] \`$topic\` — SCENT/$base:$n")
    details+=("  - residue: $residue")
    if [[ "$kind" == "missing" ]]; then
      details+=("  - memory: no \`$topic\` entry in MEMORY.md")
    else
      for i in "${!MEM_TEXTS[@]}"; do
        details+=("  - memory: $(basename "$MEMORY_FILE"):${MEM_LINES[$i]}: ${MEM_TEXTS[$i]}")
      done
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
