#!/usr/bin/env bash
# The newly provisioned deploy key has read-only access to Colony Mesh only.
# Never enable xtrace here: the input is a GitHub Actions secret.
set -euo pipefail
if [[ -z "${COLONY_MESH_DEPLOY_KEY:-}" ]]; then
  echo 'COLONY_MESH_DEPLOY_KEY is required for the private pinned dependency' >&2
  exit 1
fi
umask 077
credential_parent=$(cd "${TMPDIR:-/tmp}" && pwd -P)
credential_dir=$(mktemp -d "$credential_parent/anima-ci-key.XXXXXXXX")
# Validate before either writing credentials or registering deletion.
if [[ "${credential_dir%/*}" != "$credential_parent" ||
      ! "${credential_dir##*/}" =~ ^anima-ci-key\.[A-Za-z0-9]{8}$ ||
      ! -d "$credential_dir" || -L "$credential_dir" ]]; then
  echo 'refusing unowned credential directory' >&2
  exit 1
fi
readonly credential_parent credential_dir
# Only this installer-owned temporary child is removed. Deleting operator data
# requires human confirmation and is outside this script's authority.
trap 'rm -rf -- "$credential_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$COLONY_MESH_DEPLOY_KEY" > "$credential_dir/key"
unset COLONY_MESH_DEPLOY_KEY
# GitHub's published Ed25519 host key (see https://api.github.com/meta).
printf '%s\n' 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' > "$credential_dir/known_hosts"
export GIT_SSH_COMMAND="ssh -i \"$credential_dir/key\" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"$credential_dir/known_hosts\" -o BatchMode=yes"
# Repository and dependency lifecycle scripts cannot read this key. Run the
# repository's skills:sync only in the later, credential-free workflow step.
bun install --frozen-lockfile --ignore-scripts
