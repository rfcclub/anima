#!/usr/bin/env bash
# broadcast.sh — send one message to all (or one) ANIMA agents, show raw response
# Each agent boots on its OWN configured provider/model (no override).
# Usage:
#   bash scripts/broadcast.sh "your message here"
#   bash scripts/broadcast.sh --agent lena "your message here"

set -euo pipefail

ANIMA_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Load ANIMA env (provider API keys etc.) from the real env file at ~/.anima/anima.env.
# Note: scripts/anima.env in the repo is only the systemd template (no values); the
# real keys live in ~/.anima/anima.env. Source it so non-interactive/background shells inherit.
ANIMA_ENV="${ANIMA_ENV:-$HOME/.anima/anima.env}"
if [[ -f "$ANIMA_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ANIMA_ENV"
  set +a
fi

ALL_AGENTS=(bruno eli cleo abel pia milo sam finn hana gus rhea lena)

# Parse args
AGENTS=("${ALL_AGENTS[@]}")
if [[ "${1:-}" == "--agent" ]]; then
  AGENTS=("$2")
  shift 2
fi
MESSAGE="${1:?Usage: broadcast.sh [--agent name] \"message\"}"

echo "=== BROADCAST ==="
echo "Message: $MESSAGE"
echo "Time: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo ""

for agent in "${AGENTS[@]}"; do
  echo "──── $agent ────"
  timeout 120 bun --cwd "$ANIMA_DIR" src/cli.ts talk \
    --agent "$agent" \
    --message "$MESSAGE" \
    --permission auto \
    2>/dev/null || echo "[timeout or error]"
  echo ""
done
