#!/usr/bin/env bash
# Seed the colony cartridge tier at ~/agora/cartridges from repo sources.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${AGORA_ROOT:-$HOME/agora}/cartridges"
mkdir -p "$DEST/shared" "$DEST/skills"
cp "$REPO_DIR/seeds/agora-cartridges/shared/creative.md" "$DEST/shared/"
cp "$REPO_DIR/seeds/agora-cartridges/shared/marketing.md" "$DEST/shared/"
cp "$REPO_DIR/cartridges/shared/programming.md" "$DEST/shared/"
echo "Seeded $DEST/shared: creative, marketing, programming"
