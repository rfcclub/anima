#!/usr/bin/env bash
# deploy.sh — restart identity-runtime and verify it came back up.
#
# Unlike ANIMA's own scripts/deploy.sh, identity-runtime has no build step:
# its launchd job (scripts/identity-runtime.launchd.plist) runs
# packages/identity-runtime/src/main.ts directly from this working tree, so
# whatever is on disk here is exactly what goes live on restart. That used to
# mean no commit-clean check and no confirmation the restart actually worked
# — this script is that missing deploy hygiene.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
IDENTITY_RUNTIME_STATE_DIR="${IDENTITY_RUNTIME_STATE_DIR:-$HOME/.anima/identity-runtime/state}"
HEALTH_URL="http://127.0.0.1:${IDENTITY_RUNTIME_PORT:-13541}/health"
LAUNCHD_LABEL="${IDENTITY_RUNTIME_LAUNCHD_LABEL:-com.owner.identity-runtime}"
LAUNCHD_TARGET="gui/$(id -u)/$LAUNCHD_LABEL"

echo "=== identity-runtime Deploy ==="
echo "  source: $PROJECT_DIR (runs directly from here — no build step)"

echo ""
echo "[1/4] Checking working tree..."
(cd "$PROJECT_DIR" && bun scripts/deploy-guard.ts)

echo "[2/4] Restarting identity-runtime..."
if launchctl print "$LAUNCHD_TARGET" >/dev/null 2>&1; then
  launchctl kickstart -k "$LAUNCHD_TARGET"
  echo "  ✓ restarted via launchd ($LAUNCHD_TARGET)"
else
  echo "  ⚠ launchd job not loaded — start it manually: launchctl load $SCRIPT_DIR/../identity-runtime.launchd.plist"
  exit 1
fi

echo "[3/4] Verifying health at $HEALTH_URL..."
if (cd "$PROJECT_DIR" && bun scripts/verify-health.ts "$HEALTH_URL"); then
  mkdir -p "$IDENTITY_RUNTIME_STATE_DIR"
  cat > "$IDENTITY_RUNTIME_STATE_DIR/deploy.json" << EOF
{
  "version": "$(cd "$PROJECT_DIR" && git describe --always --dirty 2>/dev/null || echo 'unknown')",
  "deployedAt": "$(date -u -Iseconds)",
  "sourceCommit": "$(cd "$PROJECT_DIR" && git rev-parse HEAD 2>/dev/null || echo 'unknown')"
}
EOF
  echo "  ✓ deploy stamp written to $IDENTITY_RUNTIME_STATE_DIR/deploy.json"
else
  echo "  ⚠ deploy did NOT verify healthy — check ~/.anima/logs/identity-runtime.log"
  exit 1
fi

echo ""
echo "[4/4] Installing agent-loader..."
"$SCRIPT_DIR/install-agent-loader.sh"

echo ""
echo "Done."
