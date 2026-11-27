#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || ! -x /usr/bin/sandbox-exec ]]; then
  printf '%s\n' 'macOS sandbox is unavailable' >&2
  exit 1
fi

cd "$(dirname "$0")/.."
exec bun test __tests__/work/progress-state.test.ts
