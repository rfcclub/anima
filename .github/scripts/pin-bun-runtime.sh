#!/usr/bin/env bash
set -euo pipefail
# Keep nested checkout scripts on the explicitly selected, verified runtime.
# bun-plugin-tailwind's peer creates a local Bun shim even with --ignore-scripts.
runtime=$(realpath -- "${1:?absolute setup-bun executable required}")
test -x "$runtime"
if [[ "$("$runtime" --version)" != "$(cat .bun-version)" ]]; then
  echo "runtime version does not match .bun-version" >&2
  exit 1
fi
alias=node_modules/.bin/bun
if [[ -e "$alias" && ! -L "$alias" ]]; then
  echo "refusing non-symlink Bun alias" >&2
  exit 1
fi
mkdir -p node_modules/.bin
ln -sfn -- "$runtime" "$alias"
