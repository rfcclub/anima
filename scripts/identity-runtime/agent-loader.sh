#!/bin/sh
# agent-loader — launch a roster agent into a coding harness with a fresh identity, fail closed.
# Usage: agent-loader [--force] <agent> <harness> [host args...]
# Everything after <harness> is passed to the harness launcher untouched.
set -eu

script=$0
while [ -L "$script" ]; do
  link=$(readlink "$script")
  case $link in
    /*) script=$link ;;
    *) script=$(dirname "$script")/$link ;;
  esac
done
here=$(CDPATH= cd "$(dirname "$script")" && pwd)

force=
if [ "${1:-}" = "--force" ]; then
  force=--force
  shift
fi
if [ "$#" -lt 2 ]; then
  echo "usage: agent-loader [--force] <agent> <harness> [host args...]" >&2
  exit 64
fi
agent=$1
harness=$2
shift 2

launch_dir=${AGENT_LOADER_LAUNCH_DIR:-$HOME/scripts}
case $harness in
  claude)   launcher=$launch_dir/claude/claudia ;;
  codex)    launcher=$launch_dir/codex/codexia ;;
  omp)      launcher=$launch_dir/omp/omp-agent ;;
  reasonix) launcher=reasonix-patched ;;
  *)
    echo "agent-loader: unsupported harness '$harness' (supported: claude, codex, omp, reasonix)" >&2
    exit 64
    ;;
esac

if [ "$harness" = reasonix ]; then
  command -v "$launcher" >/dev/null 2>&1 || { echo "agent-loader: launcher not found on PATH: $launcher" >&2; exit 64; }
else
  [ -x "$launcher" ] || { echo "agent-loader: launcher not executable: $launcher" >&2; exit 64; }
fi

identity=$(bun "$here/agent-loader.ts" prepare --agent "$agent" --harness "$harness" $force) || exit $?

AGENT_NAME=$agent
AGENT_IDENTITY_FILE=$identity
export AGENT_NAME AGENT_IDENTITY_FILE

# Colony Mesh sidecar: registers this launch and heartbeats until the harness exits.
# exec below keeps this shell's pid, so $$ is the harness. Fail open: never blocks the launch.
if [ "${AGENT_LOADER_MESH:-1}" != 0 ]; then
  sidecar=${AGENT_LOADER_MESH_SIDECAR:-$here/../../node_modules/colony-mesh/bin/mesh-sidecar.ts}
  if [ -f "$sidecar" ]; then
    mesh_log=${AGENT_LOADER_MESH_LOG:-$HOME/.anima/logs/mesh-sidecar.log}
    mkdir -p "$(dirname "$mesh_log")" 2>/dev/null || true
    # The project the harness will run in (its installation key), read the way each launcher reads it:
    # omp-agent takes a leading directory, codex takes -C/--cd; others run in this directory.
    mesh_cwd=$PWD
    case $harness in
      omp)
        if [ "$#" -gt 0 ] && [ "$1" != -- ]; then mesh_cwd=$1; fi
        ;;
      codex)
        # Codex's clap grammar: -C <dir>, -C<dir>, --cd <dir>, --cd=<dir>; after a bare -- everything is the prompt.
        prev=
        for arg in "$@"; do
          case $prev in
            -C|--cd) mesh_cwd=$arg; prev=; continue ;;
          esac
          case $arg in
            --) break ;;
            --cd=*) mesh_cwd=${arg#--cd=} ;;
            -C?*) mesh_cwd=${arg#-C} ;;
          esac
          prev=$arg
        done
        ;;
    esac
    # An unresolvable directory is passed as given; the sidecar fails open and the launch goes ahead.
    resolved=$(CDPATH= cd -- "$mesh_cwd" 2>/dev/null && pwd -P) && mesh_cwd=$resolved
    nohup bun "$sidecar" --agent "$agent" --harness "$harness" --parent $$ --cwd "$mesh_cwd" >>"$mesh_log" 2>&1 </dev/null &
  fi
fi

case $harness in
  codex)
    exec "$launcher" "$identity" "$@"
    ;;
  reasonix)
    REASONIX_APPENDIX_FILE=$identity
    export REASONIX_APPENDIX_FILE
    exec "$launcher" "$@"
    ;;
  *)
    exec "$launcher" "$@"
    ;;
esac
