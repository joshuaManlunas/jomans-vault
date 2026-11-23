#!/usr/bin/env bash
set -euo pipefail

# Read-only preflight checks for jomans-vault:
# 1. Docker daemon is running.
# 2. Port 5432 is served by the jomans-vault-postgres container.

if ! command -v docker >/dev/null 2>&1; then
  echo "docker CLI is not installed or not on PATH." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running. Start Docker Desktop before running /factory." >&2
  exit 1
fi

# Match the host side of each binding ("0.0.0.0:5432->5432/tcp"), not the container
# side: `docker ps --filter publish=5432` also matches a "15432:5432" mapping.
host_owners=$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null |
  awk -F '\t' 'index($2, ":5432->") {print $1}' || true)
while IFS= read -r name; do
  if [ "$name" = "jomans-vault-postgres" ]; then
    exit 0
  fi
done <<< "$host_owners"

if [ -n "$host_owners" ]; then
  owners=$(printf '%s' "$host_owners" | paste -sd ', ' -)
  echo "Port 5432 is served by another Docker container (${owners}), not jomans-vault-postgres." >&2
  exit 1
fi

if command -v lsof >/dev/null 2>&1; then
  listeners=$(lsof -nP -iTCP:5432 -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 {print $1 " (pid " $2 ")"}' | sort -u | paste -sd ', ' -)
  if [ -n "$listeners" ]; then
    echo "Port 5432 is held by another process (${listeners}), not jomans-vault-postgres." >&2
    exit 1
  fi
fi

echo "jomans-vault-postgres is not serving port 5432. Start it with: bun run db:start" >&2
exit 1
