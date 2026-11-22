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

published_containers=$(docker ps --filter publish=5432 --format '{{.Names}}' 2>/dev/null || true)
while IFS= read -r name; do
  [ -z "$name" ] && continue
  if [ "$name" = "jomans-vault-postgres" ]; then
    exit 0
  fi
done <<< "$published_containers"

if [ -n "$published_containers" ]; then
  owners=$(printf '%s' "$published_containers" | paste -sd ', ' -)
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
