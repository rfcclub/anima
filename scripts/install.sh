#!/usr/bin/env bash
# install.sh — Install ANIMA systemd service + CLI wrapper
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ANIMA_HOME="${ANIMA_HOME:-$HOME/.anima}"

echo "=== ANIMA Install ==="

# 1. systemd user service
echo "[1/3] Installing systemd service..."
mkdir -p "$HOME/.config/systemd/user"
cp "$SCRIPT_DIR/anima.service" "$HOME/.config/systemd/user/anima.service"
systemctl --user daemon-reload
echo "  ✓ anima.service installed"

# 2. CLI wrapper — thin bun launcher
echo "[2/3] Installing CLI wrapper..."
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/anima" << 'WRAPPER'
#!/usr/bin/env bash
# ANIMA CLI
ANIMA_HOME="${ANIMA_HOME:-$HOME/.anima}"
cd "$ANIMA_HOME"
exec bun run dist/cli.js "$@"
WRAPPER
chmod +x "$HOME/.local/bin/anima"
echo "  ✓ ~/.local/bin/anima"

# 3. Enable
echo "[3/3] Enabling service..."
systemctl --user enable anima.service

echo ""
echo "=== Install complete ==="
echo ""
echo "Each agent has its own workspace under ~/.anima/rooms/<name>/"
echo ""
echo "  systemctl --user start anima   # start the colony"
echo "  anima status                   # colony status"
echo "  anima talk --agent bruno -m hi  # talk to an agent"
echo "  anima meet --agents bruno,eli  # run a meeting"
echo "  tail -f ~/.anima/logs/server.log"
