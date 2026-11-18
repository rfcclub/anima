#!/usr/bin/env bash
# Install @anima/openclaw-adapter and its @anima/context-engine dependency
# into an OpenClaw plugin directory.
set -e

TARGET="${1:-node_modules}"
echo "Installing @anima packages into $TARGET..."

mkdir -p "$TARGET/@anima"

# Copy both packages
cp -r "$(dirname "$0")/@anima/openclaw-adapter" "$TARGET/@anima/"
cp -r "$(dirname "$0")/@anima/context-engine" "$TARGET/@anima/"

echo "✓ @anima/context-engine installed"
echo "✓ @anima/openclaw-adapter installed"
echo ""
echo "Add to OpenClaw agent config:"
echo '  contextEngine: "anima"'
