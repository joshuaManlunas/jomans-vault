# Adapt the software factory to this project

You are a coding agent finishing a factory install. `install.sh` already copied
the files, set `base_branch`, `merge_method` and the review bots in
`factory/config.json`, set `forge` (GitHub or GitLab) from `origin`, created the labels, and added the factory section
to the agent docs. What's left needs judgment about *this* project. Work in the
repo root, change only the files named here, verify, and report.

How the factory works: `factory/FACTORY.md`.

## 1. `factory/checks.sh`

The gate runs this script on every build round and before every merge, so it
is the factory's definition of "works". The installer left it failing on
purpose. Replace the two marked `PROJECT CHECKS` lines with the project's real
commands:

- install dependencies if a fresh checkout needs them (`npm ci`, `uv sync`,
  `bundle install`…);
- then lint, typecheck, tests and build, whichever the project has.

Find them in `AGENTS.md` / `CLAUDE.md`, `package.json` scripts, `Makefile`,
`pyproject.toml`, `justfile` and the CI config. Rules:

- Keep `set -euo pipefail` and the factory self-checks above the marker.
- Non-interactive, no watch modes, nothing that rewrites files (no `--fix`, no
  `--update-snapshots`). Exit non-zero on any failure.
- It runs with a job's worktree as the working directory: use relative paths.
- Keep it as fast as the project allows; it runs several times per job.
- Configure the adopting repo's CI to run `bash factory/checks.sh`.

## 2. `factory/config.json`

Already set: `forge`, `base_branch`, `merge_method`, `review_bots.bots`,
`concurrency` (1, for a careful start). Review these settings:

- `protected_paths`: keep the two factory entries. Add a path only when no job
  should ever change it (CI config, deploy config, migrations, if that's the
  project's rule). Don't add tests: features legitimately change them, and the
  code reviewer catches weakened tests. Patterns are fnmatch, so `*` matches
  `/` too.
- `ports.base`: move it if the project already uses ports 5100–5199.
- `escalate.categories`: tailor the list at install time to the changes that
  always need a human decision. `factory/config.json` is a protected path in
  installed repos, so jobs cannot edit it themselves.
- `browser`: runs the browser stage after the gate for matching intake
  surfaces (`["ui"]` by default). The browser-tester drives a dedicated window
  in the system's Google Chrome with Codex computer use and a throwaway
  profile. Only one job can use the stage at a time. Choose a fallback `cli`
  that can resize its viewport and open and close named sessions (`--session`).
  Set its `setup` command if needed. Set `"browser": null` to disable the stage.
  The stage also stays off until `roles` has a `browser-tester` entry.
- `browser.server_env`: map environment variable names to value templates.
  Set it for any framework whose auth or base URL must match the page origin.
  For example, `{"BETTER_AUTH_URL": "http://127.0.0.1:{port}"}` aligns Better
  Auth with the job's browser origin. The tester replaces `{port}` with the
  job port and passes the values to both the dev server and the seed command.
  These values override settings in the copied env files.
- `env_files`: set this to the project's local env files as paths relative
  to the repo root, for example `["apps/web/.env"]`. Run
  `git check-ignore -- <path>` for each file and confirm that git ignores it.
  The factory copies only ignored files from the main checkout into new job
  worktrees and gives the copies mode `0600`. Leave the list empty when the
  project needs no env files.
- `review_account`: defaults to `null` for signed-out checks. For
  authenticated review, seed a test account in the job's
  local dev database. For example, provide a `db:seed-reviewer` script and set
  `review_account` to `{"email_env": "REVIEW_EMAIL", "password_env": "REVIEW_PASSWORD", "seed": "npm run db:seed-reviewer"}`.
  Omit `seed` if the account already exists locally. The tester reads each
  named variable from the process environment first, then the copied
  `env_files`, and passes it to the local seed command when configured.
  Keep credential values out of tracked files, `job.json` and review artifacts.
  Verify the browser, review account and env file settings with
  `factory/bin/route --browser`.

To enable the browser stage on an older install after `install.sh --update`:

1. Merge the new `spec-writer.md`, `builder.md`, `reviewer-ui.md`,
   `reviewer-ux.md` and `approver.md` into the project's `.claude/agents/`
   copies. Keep the project's text. The update installs `browser-tester.md`
   if it is missing. If the project already has a copy, merge the new
   instructions into it too.
2. In `factory/config.json`, add `models.terra`, `roles.browser-tester` and
   `prices_usd_per_mtok.gpt-6.1-terra` from the source config. Add the
   `browser` keys `surfaces`, `computer_use`, `chrome_app` and `server_env`
   and set `env_files` for the project. The update adds missing top-level
   keys and preserves existing nested settings.
3. Run `factory/bin/doctor` and `factory/bin/route --browser`. Confirm that
   preflight passes and the command prints the intended browser settings,
   review account configuration and env file paths.

Outside this upgrade, leave `models`, `roles`, `routing` and
`surface_reviewers` alone unless the user asks. Use `/setup-factory` to change
them.

For installs upgraded from a Claude-only price table, add the Codex entries
from the source `factory/config.json` to `prices_usd_per_mtok`. The installer
preserves the project's existing table. See Job cost in `factory/FACTORY.md`.

## Optional `factory/preflight.sh`

Add this repo-owned hook for project-specific prerequisites. `factory/bin/doctor`
runs it with Bash from the repo root before `/factory run` starts any jobs.
Keep it non-interactive. A nonzero exit blocks the run, so print a short fix
hint with each failure. For example, a Docker Compose project can check that
its database service publishes the port it expects:

```bash
#!/usr/bin/env bash
set -euo pipefail
# Check Docker is running.
docker info >/dev/null 2>&1 || { echo 'Start Docker.' >&2; exit 1; }
# Check this Compose project's db service owns the expected local port.
binding=$(docker compose port db 5432 2>/dev/null) || binding=''
[[ "$binding" == '127.0.0.1:5432' ]] || {
  echo 'Start the db service with 127.0.0.1:5432 published.' >&2
  exit 1
}
```

## 3. Agents (`.claude/agents/`)

Tailor the checklists to this stack without changing their structure, file
names, first-line formats or one-line replies.

- `intake.md`: replace the `TODO` between `<!-- factory:project -->` and
  `<!-- /factory:project -->` with one or two sentences on what the project is
  for and what kinds of requests belong in it, so intake can reject what
  doesn't. Keep the markers: `install.sh --update` leaves this file alone, but
  the markers document what's project-specific.
- `reviewer-security.md`: name this project's hot spots: its auth and session
  code, data access rules, payment and webhook handlers, and where user input
  meets queries, shells or HTML.
- `reviewer-ui.md`: where the design tokens, theme and shared components live.
- `reviewer-ux.md`: the kinds of users the app has.
- `approver.md`: the approver reads the escalation policy from
  `escalate.categories` in `factory/config.json`.

## 4. Agent docs

The installer appended a `## Software factory` section to `AGENTS.md` (or
`CLAUDE.md`). Every agent reads that file, so make sure the file as a whole
also says:

- how to set up a fresh checkout (install dependencies, env files to copy);
- how to start the dev server on a given port, if there is one;
- the validation commands, matching `factory/checks.sh`.

## 5. Review bots

`review_bots.bots` lists the bots that must review a PR's current commit
before the approver runs. Check each one is actually installed on this repo
(look at a recent PR's reviews). A listed bot that never reviews makes every
job time out. If Greptile is listed, `.greptile/config.json` should exist with
`"autoReview": ["open", "push", "rebase"]` so it re-reviews every push.

On GitLab the installer leaves the list empty: Codex's connector is
GitHub-only. If the project has review bots on its merge requests (Greptile
supports GitLab, among others), find each bot's GitLab username on a recent
MR's comments and add it with its trigger, for example
`{"login": "<bot username>", "trigger": "@<bot username> review"}`. With an
empty list the gate still requires every MR discussion to be resolved.

## 6. Verify

1. `bash factory/checks.sh` exits 0 on the current branch. If it fails, fix
   the script (not the project), or tell the user what's broken in the project.
2. `factory/bin/job queue` runs without an error.
3. `python3 -m json.tool factory/config.json` succeeds.
4. Every file in `.claude/agents/` has only `name` and `description` in its
   frontmatter.
5. `git check-ignore factory/jobs/x .worktrees/x` prints both paths.

## 7. Report

Don't commit or push unless the user asks. Tell them, in a few lines:

- what you put in `checks.sh` and that it passes;
- what you tailored in the agents;
- next: commit the install and push it to the default branch (jobs branch
  from `origin/<base_branch>`), label a small issue `factory`, and run
  `/factory run` in Claude Code;
- `concurrency` is 1; raise it in `factory/config.json` once they trust the
  PRs.
