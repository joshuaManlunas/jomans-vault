#!/usr/bin/env bash
set -euo pipefail

python3 -m json.tool factory/config.json >/dev/null
for f in factory/bin/job factory/bin/gate factory/bin/models factory/bin/route factory/bin/forge; do
  python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])' "$f"
done
bash -n factory/checks.sh
python3 -m unittest discover -s factory/tests

# PROJECT CHECKS: replace these two lines with this repo's install, lint, typecheck, test and build commands (see factory/ADAPT.md).
echo "factory/checks.sh: add this project's checks (see factory/ADAPT.md)" >&2
exit 1
