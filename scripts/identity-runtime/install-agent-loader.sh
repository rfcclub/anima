#!/bin/sh
# Install or refresh the ~/scripts/agent-loader symlink. Idempotent; never overwrites a real file.
set -eu

here=$(CDPATH= cd "$(dirname "$0")" && pwd)
target=$here/agent-loader.sh
dest_dir=${AGENT_LOADER_INSTALL_DIR:-$HOME/scripts}
dest=$dest_dir/agent-loader

mkdir -p "$dest_dir"
if [ -e "$dest" ] && [ ! -L "$dest" ]; then
  echo "install-agent-loader: $dest exists and is not a symlink; refusing to overwrite" >&2
  exit 1
fi
ln -sfn "$target" "$dest"
echo "  ✓ $dest -> $target"
