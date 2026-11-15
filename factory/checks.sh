#!/usr/bin/env bash
set -euo pipefail

python3 -m json.tool factory/config.json >/dev/null
for f in factory/bin/job factory/bin/gate factory/bin/models factory/bin/route factory/bin/forge; do
  python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])' "$f"
done
bash -n factory/checks.sh
python3 -m unittest discover -s factory/tests

# PROJECT CHECKS
# Varlock validates env at build time and job worktrees have no apps/web/.env.
# These are non-secret local defaults (the DB URL matches docker-compose's dev Postgres).
export NODE_ENV="${NODE_ENV:-test}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-factory-checks-placeholder-secret-0000000000}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:3001}"
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:password@localhost:5432/jomans-vault}"

bun install --frozen-lockfile
bun run check
bun run check-types
bun run build

# Tests run once the repo defines a root "test" script; they use the shared dockerized Postgres.
if python3 -c 'import json, sys; sys.exit("test" not in json.load(open("package.json")).get("scripts", {}))'; then
  docker compose up -d --wait postgres
  bun run test
fi
