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

## 2. `factory/config.json`

Already set: `forge`, `base_branch`, `merge_method`, `review_bots.bots`,
`concurrency` (1, for a careful start). Check two more:

- `protected_paths`: keep the two factory entries. Add a path only when no job
  should ever change it (CI config, deploy config, migrations, if that's the
  project's rule). Don't add tests: features legitimately change them, and the
  code reviewer catches weakened tests. Patterns are fnmatch, so `*` matches
  `/` too.
- `ports.base`: move it if the project already uses ports 5100–5199.

Leave `models`, `roles`, `routing` and `surface_reviewers` alone unless the
user asks; `/setup-factory` is how they change them.

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
- `approver.md`: add to the ESCALATE list what a human must always see in this
  project.

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
