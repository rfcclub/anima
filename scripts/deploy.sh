#!/usr/bin/env bash
# deploy.sh — Build ANIMA and deploy to ~/.anima/
set -euo pipefail

ANIMA_HOME="${ANIMA_HOME:-$HOME/.anima}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== ANIMA Deploy ==="
echo "  source: $PROJECT_DIR"
echo "  target: $ANIMA_HOME"

# 0. Refuse a dirty deploy by default: a `-dirty` stamp is easy to miss, so
# carrying unrelated uncommitted work into prod requires an explicit
# ALLOW_DIRTY=1 instead of being the silent default.
echo ""
echo "[0/9] Checking working tree..."
(cd "$PROJECT_DIR" && bun scripts/deploy-guard.ts)

# 0b. Choose and stage the roster before anything is built or copied. The staged bytes are what is installed later.
mkdir -p "$ANIMA_HOME/data"
ROSTER_SRC="$(bun "$PROJECT_DIR/scripts/deploy-roster.ts" choose "$PROJECT_DIR/data/colony.json" "$ANIMA_HOME/data/colony.json" "${ANIMA_OVERLAY_DIR:-}" "$PROJECT_DIR")"
ROSTER_STAGE="$(mktemp "$ANIMA_HOME/data/.colony.stage.XXXXXX")"
trap 'rm -f "$ROSTER_STAGE"' EXIT
cp "$ROSTER_SRC" "$ROSTER_STAGE"
chmod 600 "$ROSTER_STAGE"
bun "$PROJECT_DIR/scripts/deploy-roster.ts" validate "$ROSTER_STAGE"
ROSTER_FROM="$( [ "$ROSTER_SRC" = "$PROJECT_DIR/data/colony.json" ] && echo checkout || echo overlay )"

# 1. Build
echo ""
echo "[1/4] Building server..."
cd "$PROJECT_DIR"
BUILD_VERSION="$(date +%Y%m%d-%H%M%S)"
BUILD_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "  build version: $BUILD_VERSION"
# Write version.json so /api/version can report it at runtime (read by
# the UI server from ~/.anima/state/version.json).
mkdir -p "$ANIMA_HOME/state"
cat > "$ANIMA_HOME/state/version.json" << EOF
{"version":"$BUILD_VERSION","builtAt":"$BUILD_AT"}
EOF
bun build src/server.ts \
  --outfile "$ANIMA_HOME/dist/server.js" \
  --target bun \
  --format esm \
  --sourcemap=inline

# Also build CLI
bun build src/cli.ts \
  --outfile "$ANIMA_HOME/dist/cli.js" \
  --target bun \
  --format esm \
  --minify

# Optional web-chat bridge workers. Building does not activate accounts or launch a browser.
bun build src/web-chat/worker.ts \
  --outfile "$ANIMA_HOME/dist/web-chat-worker.js" --target bun --format esm --minify
bun build src/web-chat/browser-worker.ts \
  --outfile "$ANIMA_HOME/dist/web-chat-browser-worker.mjs" --target node --format esm --external playwright
bun build src/web-chat/cli.ts \
  --outfile "$ANIMA_HOME/dist/web-chat-cli.js" --target bun --format esm --minify

echo "  ✓ server, CLI and optional web-chat workers built"

# 2. Copy runtime assets
echo "[2/4] Copying runtime assets..."

# rooms/ — generate structure on first install (no source dependency)
if [ ! -d "$ANIMA_HOME/rooms" ]; then
  AGENTS=(bruno abel cleo dana eli finn gus hana ivan milo nora rhea sam)
  NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  DEFAULT_TRUST=$(cat <<TRUST
{
  "version": 1,
  "domains": {
    "code_review":    {"score": 0.5, "samples": 0, "lastUpdated": "$NOW"},
    "memory_write":   {"score": 0.5, "samples": 0, "lastUpdated": "$NOW"},
    "external_action":{"score": 0.5, "samples": 0, "lastUpdated": "$NOW"},
    "architecture":   {"score": 0.5, "samples": 0, "lastUpdated": "$NOW"},
    "communication":  {"score": 0.5, "samples": 0, "lastUpdated": "$NOW"},
    "private_mode":          {"score": 0.5, "samples": 0, "lastUpdated": "$NOW"}
  }
}
TRUST
)
  for agent in "${AGENTS[@]}"; do
    mkdir -p "$ANIMA_HOME/rooms/$agent/sessions" \
             "$ANIMA_HOME/rooms/$agent/memory" \
             "$ANIMA_HOME/rooms/$agent/staging"
    echo "$DEFAULT_TRUST" > "$ANIMA_HOME/rooms/$agent/trust.json"
  done
  mkdir -p "$ANIMA_HOME/rooms/_shared/vn/assets" \
           "$ANIMA_HOME/rooms/staging/dreams"
  echo "  ✓ rooms/ generated (${#AGENTS[@]} agents)"
else
  echo "  • rooms/ exists, skipping"
fi

# providers.d/ — seed if missing
if [ ! -d "$ANIMA_HOME/providers.d" ]; then
  cp -r "$PROJECT_DIR/providers.d" "$ANIMA_HOME/providers.d"
  echo "  ✓ providers.d/ seeded"
else
  echo "  • providers.d/ exists, skipping"
fi

# skills/ + cartridges/ — always sync (global tier)
rm -rf "$ANIMA_HOME/skills" "$ANIMA_HOME/cartridges"
cp -r "$PROJECT_DIR/skills" "$ANIMA_HOME/skills"
cp -r "$PROJECT_DIR/cartridges" "$ANIMA_HOME/cartridges"
echo "  ✓ skills/ + cartridges/ synced"

# ui/ — always sync so UI server has HTML/components/styles. Exclude dist/
# (gitignored build artifact): if a stale dist/ sits in src/ui it would
# clobber the freshly-built bundle below, serving old JS.
rm -rf "$ANIMA_HOME/ui"
mkdir -p "$ANIMA_HOME/ui"
rsync -a --exclude='dist' "$PROJECT_DIR/src/ui/" "$ANIMA_HOME/ui/"
echo "  ✓ ui/ synced (dist/ excluded)"

# Build the client bundle into the deployed ui/dist/. The server reads
# index.html + hashed JS/CSS from here per request (no in-memory cache),
# so a fresh build here is picked up by the running server immediately —
# no restart needed. Without this, a stale or missing dist/ means the SPA
# shell loads with no JS and the page goes black.
echo "[build] building client bundle..."
(
  cd "$PROJECT_DIR"
  bun -e "
    const result = await Bun.build({
      entrypoints: ['src/ui/index.html'],
      outdir: process.env.HOME + '/.anima/ui/dist',
      target: 'browser',
      format: 'esm',
      sourcemap: 'inline',
      naming: { entry: '[name].[ext]', chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]' },
      publicPath: '/',
      plugins: [(await import('bun-plugin-tailwind')).default],
    });
    if (!result.success) { console.error('bundle build failed', result.logs); process.exit(1); }
    console.log('  ✓ bundle built:', result.outputs.map(o => o.path.split('/').pop()).join(', '));
  "
)

# data/ — sync static colony metadata used by server startup
mkdir -p "$ANIMA_HOME/data"
# Install the staged, validated roster; every previous runtime roster is kept under its own timestamped name.
if [ -f "$ANIMA_HOME/data/colony.json" ]; then cp -p "$ANIMA_HOME/data/colony.json" "$ANIMA_HOME/data/colony.json.pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)"; fi
mv "$ROSTER_STAGE" "$ANIMA_HOME/data/colony.json"
echo "  ✓ data/colony.json installed from $ROSTER_FROM"

# openspec/ — when present, sync the change tree so the /projects dashboard
# (reads openspec/changes + openspec/archive) has data. Without it the
# server's cwd (~/.anima/) has no openspec/ and the dashboard renders empty.
if [ -d "$PROJECT_DIR/openspec" ]; then
  rsync -a --delete \
    "$PROJECT_DIR/openspec/" "$ANIMA_HOME/openspec/"
  echo "  ✓ openspec/ synced (dashboard source)"
fi

# package.json + node_modules for bun runtime
bun "$PROJECT_DIR/scripts/prepare-runtime-manifest.ts" \
  "$PROJECT_DIR/package.json" "$ANIMA_HOME/package.json"
echo "  ✓ package.json"

# 3. Install deps (production only)
echo "[3/4] Installing dependencies..."
cd "$ANIMA_HOME"
bun install --production 2>&1 | tail -1

# 4. Create state dirs + seed env + stamp
echo "[4/8] Creating runtime directories..."
mkdir -p "$ANIMA_HOME/logs"
mkdir -p "$ANIMA_HOME/backups"
mkdir -p "$ANIMA_HOME/state"
# sessions.db lives at $ANIMA_HOME/sessions.db — ensure parent writable
touch "$ANIMA_HOME/.write-check" && rm "$ANIMA_HOME/.write-check"

# Seed env file if missing
if [ ! -f "$ANIMA_HOME/anima.env" ]; then
  cp "$PROJECT_DIR/scripts/anima.env" "$ANIMA_HOME/anima.env"
  echo "  ✓ anima.env seeded (edit with your API keys)"
else
  echo "  • anima.env exists, skipping"
fi

# 5. Migrate JSONL sessions to SQLite (idempotent — skips if already migrated)
echo "[5/8] Migrating sessions to SQLite..."
if ls "$ANIMA_HOME/rooms"/*/sessions/*.jsonl 2>/dev/null | grep -q '.'; then
  ANIMA_SESSIONS_DB="$ANIMA_HOME/sessions.db" bun "$PROJECT_DIR/scripts/migrate-sessions.ts"
else
  echo "  • No JSONL files to migrate"
fi

# 6. Migrate A2A meetings to SQLite (idempotent — skips if nothing to migrate)
echo "[6/8] Migrating A2A meeting files..."
if [ -d "$ANIMA_HOME/rooms/_meeting" ] && compgen -G "$ANIMA_HOME/rooms/_meeting/*/*.md" > /dev/null 2>&1; then
  ANIMA_SESSIONS_DB="$ANIMA_HOME/sessions.db" ANIMA_ROOMS_DIR="$ANIMA_HOME/rooms" bun "$PROJECT_DIR/scripts/migrate-a2a.ts"
else
  echo "  • No A2A meeting files to migrate"
fi

# 7. Write version stamp
echo "[7/8] Writing deploy stamp..."

cat > "$ANIMA_HOME/state/deploy.json" << EOF
{
  "version": "$(cd "$PROJECT_DIR" && git describe --always --dirty 2>/dev/null || echo '0.1.0')",
  "deployedAt": "$(date -u -Iseconds)",
  "sourceCommit": "$(cd "$PROJECT_DIR" && git rev-parse HEAD 2>/dev/null || echo 'unknown')"
}
EOF
echo "  ✓ deploy stamp written"

# 8. Restart the running server so it picks up the freshly-built server.js
# AND the current anima.env. Without this, a long-running server keeps its
# original env (stale API keys) and never sees code/env changes — deploy
# would silently serve the old process. start.sh sources anima.env, so the
# new process gets the right keys.
#
# When the launchd job is loaded (KeepAlive=true), ask launchd to restart it
# rather than killing the process by hand: a manual pkill would trigger
# launchd's own respawn at the same time as a manually spawned replacement and
# leave two server processes racing. Fall back to manual management only when
# the job is not loaded.
echo "[8/9] Restarting server..."
LAUNCHD_LABEL="${ANIMA_LAUNCHD_LABEL:-com.owner.anima}"
LAUNCHD_TARGET="gui/$(id -u)/$LAUNCHD_LABEL"
if launchctl print "$LAUNCHD_TARGET" >/dev/null 2>&1; then
  launchctl kickstart -k "$LAUNCHD_TARGET"
  echo "  ✓ server restarted via launchd ($LAUNCHD_TARGET)"
elif [ -f "$ANIMA_HOME/start.sh" ]; then
  # launchd job genuinely not loaded — manage the lifecycle manually.
  # Stop any existing server (graceful then force). pkill -f only matches
  # processes whose command line contains the absolute dist/server.js path —
  # a server started manually with a relative path (e.g. `cd ~/.anima &&
  # bun dist/server.js`) won't match and would silently keep squatting on
  # the ports while the freshly-started process fails to bind and sits idle.
  # Kill by LISTENING PORT too so no invocation style can survive a deploy.
  pkill -f "$ANIMA_HOME/dist/server.js" 2>/dev/null || true
  for p in "${PORT:-3700}" "${ANIMA_UI_PORT:-3000}"; do
    lsof -ti "tcp:$p" -sTCP:LISTEN 2>/dev/null | while read -r pid; do kill "$pid" 2>/dev/null || true; done || true
  done
  sleep 1
  pkill -9 -f "$ANIMA_HOME/dist/server.js" 2>/dev/null || true
  for p in "${PORT:-3700}" "${ANIMA_UI_PORT:-3000}"; do
    lsof -ti "tcp:$p" -sTCP:LISTEN 2>/dev/null | while read -r pid; do kill -9 "$pid" 2>/dev/null || true; done || true
  done
  # Start fresh, detached, logging to the usual log file.
  nohup bash "$ANIMA_HOME/start.sh" > "$ANIMA_HOME/logs/server.log" 2>&1 &
  disown
  echo "  ✓ server restarted manually (start.sh sources anima.env)"
else
  echo "  ⚠ start.sh not found — server not restarted. Run manually: bash ~/.anima/start.sh"
fi

# 9. Verify the restart actually worked: a restart command exiting 0 does not
# prove the new process came up; this polls /health and fails the deploy
# loudly instead of leaving a dead server undetected.
echo "[9/10] Verifying server health..."
if (cd "$PROJECT_DIR" && bun scripts/verify-health.ts "http://127.0.0.1:${PORT:-3700}/health"); then
  :
else
  echo "  ⚠ deploy did NOT verify healthy — check $ANIMA_HOME/logs/server.log"
  exit 1
fi

DEPLOYED_COMMIT="$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
ORIGIN_HEAD="$(git -C "$PROJECT_DIR" ls-remote origin HEAD 2>/dev/null | cut -c1-7 || true)"
echo "  deployed commit: $DEPLOYED_COMMIT; origin head: ${ORIGIN_HEAD:-unknown}"
# Optional work log (ANIMA_WORKLOG): one line per deploy with the commit, the build and the roster source.
if [ -n "${ANIMA_WORKLOG:-}" ]; then
  echo "- $(date -u +%Y-%m-%dT%H:%M:%SZ) deploy commit=$DEPLOYED_COMMIT origin=${ORIGIN_HEAD:-unknown} build=$BUILD_VERSION roster=$ROSTER_FROM" >> "$ANIMA_WORKLOG"
fi
echo "[10/10] Done."
echo ""
echo "=== ~/.anima/ structure ==="
echo "  dist/          — compiled server.js + cli.js"
echo "  rooms/         — agent workspaces (bruno, eli, milo, ...)"
echo "  providers.d/   — model provider registry (gemini, anthropic, exampleprov, ...)"
echo "  anima.env      — API keys + config"
echo "  logs/          — server logs"
echo "  state/         — deploy stamp"
echo "  backups/       — pre-migration backups"
echo ""
echo "Start:  systemctl --user start anima"
echo "CLI:    bun ~/.anima/dist/cli.js talk --agent bruno --message \"hello\""
