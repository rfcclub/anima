#!/usr/bin/env bash
# verify-memory-access.sh
# Sends a memory verification message to each ANIMA agent with shared memory.
# Usage: bash scripts/verify-memory-access.sh [--agent <name>]
#
# Each agent is asked to run anima_bootstrap + anima_stats and confirm access.
# Results are printed to stdout and logged to /tmp/anima-verify-<agent>.log

set -euo pipefail

ANIMA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS=(eli abel cleo finn gus ivan lena hana milo nora rhea pia sam)
TIMEOUT=90
PASS=0
FAIL=0
SKIP=0
PROVIDER="${ANIMA_PROVIDER:?set ANIMA_PROVIDER to a configured provider id}"
MODEL="${ANIMA_MODEL:?set ANIMA_MODEL to a model id served by that provider}"

VERIFY_MSG="MEMORY VERIFY: Please run anima_bootstrap to initialize your memory store, then run anima_stats to check status. Reply with: [OK] if bootstrap succeeded and stats returned, or [FAIL <reason>] if any error occurred. No explanation needed beyond the status."

# Allow single-agent mode
if [[ "${1:-}" == "--agent" && -n "${2:-}" ]]; then
  AGENTS=("$2")
fi

echo "=== ANIMA Memory Access Verification ==="
echo "Agents: ${AGENTS[*]}"
echo "Time: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo ""

for agent in "${AGENTS[@]}"; do
  printf "%-10s ... " "$agent"
  LOG="/tmp/anima-verify-${agent}.log"

  result=$(timeout "$TIMEOUT" bun --cwd "$ANIMA_DIR" src/cli.ts talk \
    --agent "$agent" \
    --message "$VERIFY_MSG" \
    --permission auto \
    --provider "$PROVIDER" \
    --model "$MODEL" \
    2>"$LOG" || echo "TIMEOUT_OR_ERROR")

  if echo "$result" | grep -qi "\[OK\]"; then
    echo "✅ OK"
    PASS=$((PASS + 1))
  elif echo "$result" | grep -qi "\[FAIL"; then
    reason=$(echo "$result" | grep -oi "\[FAIL[^]]*\]" | head -1)
    echo "❌ $reason"
    FAIL=$((FAIL + 1))
  elif [[ "$result" == "TIMEOUT_OR_ERROR" ]]; then
    echo "⚠️  timeout/error — see $LOG"
    SKIP=$((SKIP + 1))
  else
    # Agent responded but without the exact tag — show first line
    first=$(echo "$result" | head -1 | cut -c1-80)
    echo "❓ unexpected: $first"
    SKIP=$((SKIP + 1))
  fi
done

echo ""
echo "=== Results: ✅ $PASS OK  ❌ $FAIL FAIL  ⚠️  $SKIP SKIP ==="
