#!/usr/bin/env bash
# evaluate-session-traces.sh — decision layer over kai's pending session traces.
#
# Scores each pending trace in <kai>/session-traces against the criteria listed in
# <kai>/GATES.md, then:
#   - promotes it to <kai>/EMBERS.md            (every criterion met)
#   - prunes it into <kai>/session-traces/pruned (ratio below the borderline threshold)
#   - leaves it pending                          (borderline: the owner decides)
#
# Separation from pulse-kai-session-trace-cleanup.sh: this script decides, the
# cleanup script archives. Nothing here is deleted, and no raw trace is relocated
# outside the decision folders (promoted/ and pruned/).
#
# Every run scores the whole pending set, so a trace left pending is re-scored
# once the owner completes it. Each trace keeps exactly one line in
# session-traces/evaluations.jsonl: the latest decision replaces the previous one.
#
# Criteria format in GATES.md, one per line:
#   - <metric> <op> <value>
# e.g.
#   - words >= 20
#   - sections >= 2
#   - has_summary == 1
#   - has_decisions == 1
#
# Metrics: `words` (wc -w), `sections` (count of `## ` headings) and
# `has_<term>` (1 when a heading contains <term>, case-insensitive).
# Ops: >= <= == != > <
#
# Usage: evaluate-session-traces.sh [--dry-run]
#   AGORA_ROOT             colony root (default: $HOME/agora)
#   KAI_DIR                kai's surface dir (default: $AGORA_ROOT/familia/kai)
#   KAI_TRACE_DIR          pending traces (default: $KAI_DIR/session-traces)
#   KAI_GATES              criteria file (default: $KAI_DIR/GATES.md)
#   KAI_EMBERS             embers file (default: $KAI_DIR/EMBERS.md)
#   KAI_BORDERLINE_RATIO   >= this ratio stays pending, below it is pruned (default: 0.75)
#   KAI_MIN_CRITERIA       refuse to run without at least this many criteria (default: 1)
#
# Exit codes: 0 success, 1 the check could not run (missing GATES.md/criteria,
# invalid threshold, unreadable trace), 2 usage error.
set -euo pipefail

DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h)
      # Print the header comment block whatever its length: lines after the
      # shebang, up to the first line of code.
      awk 'NR > 1 { if ($0 !~ /^#/) exit; print }' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "evaluate-session-traces.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

AGORA_ROOT="${AGORA_ROOT:-$HOME/agora}"
KAI_DIR="${KAI_DIR:-$AGORA_ROOT/familia/kai}"
TRACE_DIR="${KAI_TRACE_DIR:-$KAI_DIR/session-traces}"
GATES_FILE="${KAI_GATES:-$KAI_DIR/GATES.md}"
EMBERS_FILE="${KAI_EMBERS:-$KAI_DIR/EMBERS.md}"
BORDERLINE_RATIO="${KAI_BORDERLINE_RATIO:-0.75}"
MIN_CRITERIA="${KAI_MIN_CRITERIA:-1}"

fail() { echo "evaluate-session-traces.sh: $*" >&2; exit 1; }

[[ "$BORDERLINE_RATIO" =~ ^[0-9]+(\.[0-9]+)?$ ]] || fail "invalid KAI_BORDERLINE_RATIO: $BORDERLINE_RATIO"
[[ "$MIN_CRITERIA" =~ ^[0-9]+$ ]] || fail "invalid KAI_MIN_CRITERIA: $MIN_CRITERIA"
[[ -f "$GATES_FILE" ]] || fail "no GATES.md at $GATES_FILE — refusing to score traces without gate criteria"
[[ -d "$TRACE_DIR" ]] || fail "no pending trace directory at $TRACE_DIR"

# ── Criteria ──────────────────────────────────────────────────────────────────

CRITERIA=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ "$line" == "- "* ]] || continue
  CRITERIA+=("${line#- }")
done < "$GATES_FILE"

COUNT="${#CRITERIA[@]}"
(( COUNT >= MIN_CRITERIA )) || fail "no gate criteria (>= $MIN_CRITERIA) found in GATES.md at $GATES_FILE"

# ── Scoring ───────────────────────────────────────────────────────────────────

metric() {
  local name="$1" value
  case "$name" in
    words) value=$(wc -w < "$2" | tr -d ' '); echo "$((value))" ;;
    sections) value=$(grep -c '^## ' "$2" || true); echo "$((value))" ;;
    has_*) term="${name#has_}"
      if grep -qiE "^#+ .*${term}" "$2"; then echo 1; else echo 0; fi ;;
    *) return 1 ;;
  esac
}

# compare <actual> <op> <expected>; numeric comparison via awk (portable, no bc).
# Exit 0 when the comparison holds, 1 when it does not; the caller validates the
# operator separately because awk cannot be asked "unknown operator?" and
# "comparison false?" at the same time.
compare() {
  awk -v a="$1" -v op="$2" -v b="$3" 'BEGIN {
    if (op == ">=" ) exit !(a + 0 >= b + 0)
    if (op == "<=" ) exit !(a + 0 <= b + 0)
    if (op == "==" ) exit !(a + 0 == b + 0)
    if (op == "!=" ) exit !(a + 0 != b + 0)
    if (op == ">"  ) exit !(a + 0 >  b + 0)
    if (op == "<"  ) exit !(a + 0 <  b + 0)
    exit !(a + 0 >= b + 0)
  }'
}

score_trace() {
  local file="$1" criterion name op expected actual
  SCORE=0
  for criterion in "${CRITERIA[@]}"; do
    read -r name op expected _ <<< "$criterion" || true
    [[ -n "${name:-}" && -n "${op:-}" && -n "${expected:-}" ]] || fail "malformed criterion in GATES.md: $criterion"
    actual=$(metric "$name" "$file") || fail "unknown gate metric in GATES.md: $name"
    case "$op" in ">="|"<="|"=="|"!="|">"|"<") ;; *) fail "unknown gate operator in GATES.md: $op" ;; esac
    if compare "$actual" "$op" "$expected"; then SCORE=$((SCORE + 1)); fi
  done
}

# ratio_meets <score> <count> <ratio> -> 0 when score/count >= ratio
ratio_meets() {
  awk -v s="$1" -v n="$2" -v r="$3" 'BEGIN { exit !(n > 0 && s / n >= r + 0) }'
}

# ── Decision ──────────────────────────────────────────────────────────────────

shopt -s nullglob
pending=()
for file in "$TRACE_DIR"/*.md; do
  [[ "$(basename "$file")" == "EMBERS.md" ]] && continue
  pending+=("$file")
done

if (( ${#pending[@]} == 0 )); then
  echo "evaluate-session-traces.sh: no pending traces in $TRACE_DIR"
  exit 0
fi

LEDGER="$TRACE_DIR/evaluations.jsonl"
promoted=0; pruned=0; held=0

# record <trace> <outcome> <score>
# One line per trace: a trace that stays pending is scored again on the next run,
# so its previous line is replaced instead of accumulating.
record() {
  if [[ -f "$LEDGER" ]]; then
    grep -Fv "\"trace\":\"$1\"" "$LEDGER" > "$LEDGER.next" || true
    mv "$LEDGER.next" "$LEDGER"
  fi
  printf '{"trace":"%s","outcome":"%s","score":%d,"criteria":%d}\n' "$1" "$2" "$3" "$COUNT" >> "$LEDGER"
}

if (( DRY_RUN == 0 )); then
  mkdir -p "$TRACE_DIR/promoted" "$TRACE_DIR/pruned"
fi

for file in "${pending[@]}"; do
  name="$(basename "$file")"
  score_trace "$file"

  if (( SCORE == COUNT )); then
    outcome=promoted
  elif ratio_meets "$SCORE" "$COUNT" "$BORDERLINE_RATIO"; then
    outcome=borderline
  else
    outcome=pruned
  fi

  printf '%-40s %s (%d/%d)\n' "$name" "$outcome" "$SCORE" "$COUNT"

  if (( DRY_RUN == 1 )); then
    case "$outcome" in
      promoted) promoted=$((promoted + 1)) ;;
      pruned) pruned=$((pruned + 1)) ;;
      *) held=$((held + 1)) ;;
    esac
    continue
  fi

  case "$outcome" in
    promoted)
      if [[ ! -f "$EMBERS_FILE" ]]; then
        {
          echo "# EMBERS"
          echo
          echo "Traces promoted from session-traces after passing every criterion in GATES.md."
          echo
        } > "$EMBERS_FILE"
      fi
      {
        echo "## ${name%.md}"
        echo
        cat "$file"
        echo
      } >> "$EMBERS_FILE"
      mv "$file" "$TRACE_DIR/promoted/$name"
      promoted=$((promoted + 1)) ;;
    pruned)
      mv "$file" "$TRACE_DIR/pruned/$name"
      pruned=$((pruned + 1)) ;;
    *)
      held=$((held + 1)) ;;
  esac

  record "$name" "$outcome" "$SCORE"
done

if (( DRY_RUN == 1 )); then
  echo "dry run: promoted=$promoted pruned=$pruned borderline=$held (nothing written)"
else
  echo "evaluated ${#pending[@]} trace(s): promoted=$promoted pruned=$pruned borderline=$held"
fi
