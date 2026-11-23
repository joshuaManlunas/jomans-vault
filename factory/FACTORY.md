# The software factory (T3 Code edition)

How this repo's factory works as it stands, why it's built this way, and where
it differs from the reference it came from. Read this before changing the
factory or building your own.

- Reference: [zazencodes software-factory-claude-code-v2](https://github.com/zazencodes/zazencodes-season-3/tree/main/src/software-factory-claude-code-v2)
  (GPLv3). Its `DESIGN.md` explains the original decisions; this document keeps
  that reasoning and marks every place this copy changed it.
- Installed and adapted: 2026-11-12.

## Contents

1. [The idea](#the-idea)
2. [Pieces](#pieces)
3. [The pipeline](#the-pipeline)
4. [Job state](#job-state)
5. [The job folder](#the-job-folder)
6. [Agents](#agents)
7. [Models and routing](#models-and-routing)
8. [The scripts](#the-scripts)
9. [How it runs in T3 Code](#how-it-runs-in-t3-code)
10. [Splitting large issues](#splitting-large-issues)
11. [GitHub and GitLab](#github-and-gitlab)
12. [Review bots](#review-bots)
13. [Guardrails](#guardrails)
14. [What the T3 edition gave up](#what-the-t3-edition-gave-up)
15. [Operating it](#operating-it)
16. [Installing into another project](#installing-into-another-project)
17. [Building your own](#building-your-own)

## The idea

A software factory turns a queue of requests into merged code through a fixed
pipeline. Two kinds of worker split the work:

- **Scripts** do everything deterministic: moving state, running checks,
  labelling issues, creating worktrees, merging. They refuse illegal moves.
- **Agents** do the judgment between those steps: is this worth building, what
  exactly to build, the code, and whether the result is good.

Every step leaves a file behind, so you can see what happened and why. Each
agent's report opens with a machine-readable first line (`DECISION: ACCEPT`,
`STATUS: READY`, `BROWSER: PASS`, `VERDICT: PASS`, `APPROVE`) and a
`## Summary` for a human. The orchestrator reads verdicts from the first
lines, which keeps its context small enough to run many jobs.

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Queue | Issues labeled `factory` on the repo's forge (GitHub or GitLab) | What to build. Only people with triage or write access can label, so the label is the trust boundary. |
| Orchestrator | `.claude/skills/factory/SKILL.md` | The session running `/factory`. Starts jobs, spawns agents as T3 children, calls the scripts. Writes no code, specs or reviews, and never edits `job.json`. |
| Agents | `.claude/agents/*.md` | One instruction file per role. Agents leave reports and reply with one line. |
| Spine | `factory/bin/job`, `gate`, `route` | Python, standard library only. `job` is the only writer of `job.json`. |
| Config | `factory/config.json` | Concurrency, rounds, `auto_split`, labels, models, routing, protected paths, browser settings, env files, ports, prices. |
| Checks | `factory/checks.sh` | The repo's lint, typecheck, test and build. The only repo-specific script. |
| State | `factory/jobs/<job-id>/` | `job.json` plus every file the job wrote. Gitignored; local to the machine running the factory. |
| Worktrees | `.worktrees/<job-id>/` | One full checkout per job, on branch `factory/<job-id>`. Gitignored. |
| Dashboard | `factory/dashboard.html`, `factory/bin/dashboard` | Reads `factory/jobs/` and shows each job's stage, rounds, verdicts, cost and time. `/factory run` starts and opens it. |
| Exit | the PR | Every job ends as one PR that closes its issue. Merging it is the approval. |

## The pipeline

```
issue labeled `factory`
        │
        ▼
intake (Fable 5.2) ── NEEDS-INFO → asks the author on the issue, parks until they reply
        │             REJECT     → says why on the issue, removes the label
        │             SPLIT      → proposes 2–6 child issues (see "Splitting large issues")
        │                          auto_split false: you approve → job split files the children
        │                          each child is a new `factory` issue that starts here at intake
        ▼ ACCEPT (maybe rescoped), with risk + surfaces
route (script)        picks reviewers and their models from config.json
        ▼
worktree (script)     factory/<job-id> from origin/main
        ▼
spec-writer (Opus 5.5) → spec.md with testable acceptance criteria
        ▼
builder (gpt-6.1-sol) → commits, pushes, opens a draft PR "Closes #n", build.md
        ▼
gate (script) ─FAIL──────► builder; checks.sh + protected paths
        ▼ PASS
browser (gpt-6.1-terra) ─► when needed; FAIL → builder, BLOCKED → needs-human
        ▼ PASS or skipped
reviewers ─CHANGES───────► builder; code, + ux & ui on UI changes, + security; all in parallel
        ▼ all PASS (bot-fix rounds skip internal reviewers)
bot reviews ─FAIL────────► builder; PR marked ready, bots review HEAD, unresolved threads send it back
        ▼ PASS            (TIMEOUT: a bot never reviewed HEAD → needs-human)
approver (Opus 5.5) ── APPROVE  → sync with main, gate again, merge the PR
                    └─ ESCALATE → PR ready, decision posted, issue labeled factory:needs-human
```

A **round** starts with build and gate. After a passing gate and any required
browser test, a normal round goes to internal review and a bot-fix round goes
to approve for bot reviews. A job gets at most `max_rounds` (3) rounds. A
failure on the last round goes to a human. Feedback from a human on an
escalated job starts a fresh budget of `max_rounds`.

The orchestrator advances a job only when its current agent or script
finishes. It reports one line per transition, for example
`004-dark-mode #12: gate PASS → reviewing (code, ux, ui)`.

### Browser stage

After a passing gate, a job needs browser testing when `roles` has a
`browser-tester` entry, `browser` is an object, intake's surfaces match
`browser.surfaces` (default `["ui"]`), and the round is normal or HEAD lacks
a matching `BROWSER: PASS` in the most recent earlier round that passed.
Set `"browser": null` or `"browser": false` in `factory/config.json` to
disable the stage.

Only one job can be in `browser` at a time because computer use shares the
desktop. If `job advance <id> browser` returns `browser busy:` with another
job's id, the orchestrator leaves the job in `gate` and retries when the other
job leaves `browser`.

The browser-tester runs the worktree's dev server and follows the spec's
`## Browser script` on its loopback port. It drives a dedicated Chrome window
with Codex computer use and a throwaway profile. On Linux it uses the first
available of `google-chrome` and `chromium`.
`browser.computer_use` is enabled by default. If it is disabled or computer
use or Chrome is unavailable, the tester runs `browser.setup` if set and uses
`browser.cli` (`agent-browser` by default) with `--session <job-id>-browser`.
The test uses only the local server and never uses T3's built-in preview.

Set `browser.server_env` when the app's auth or base URL must match
`http://127.0.0.1:<port>`. It maps environment variable names to value
templates, for example `{"BETTER_AUTH_URL": "http://127.0.0.1:{port}"}`.
The tester replaces `{port}` with the job port and passes the values to the
dev server and seed command, overriding settings in the copied env files.

For sign-in steps, the tester reads the variables named in `review_account`
from its process environment first, then from the worktree copies of
`env_files`. Set `env_files` to the repo-relative paths of the project's
local env files, for example `["apps/web/.env"]`. The factory copies them
from the main checkout when it creates the worktree, only if git ignores
them, and sets mode `0600`. The tester runs the configured seed command once
against local data when the script needs sign-in. Credential values stay
out of the report, screenshots and logs.

The tester writes `round-<N>/browser.md` with per-step results tied to HEAD
and PNGs in `round-<N>/browser/`. The report's `## Widths` table lists a
desktop and a 390 × 844 phone capture for every changed page. The UI and UX
reviewers check both. PASS requires every step to run and match. FAIL sends
a product defect, including a phone layout defect, to the builder while
rounds remain. BLOCKED sends an environmental problem to a human.

## Job state

`job.json`'s `stage` is one of thirteen values. The legal moves are in
`TRANSITIONS` at the top of `factory/bin/job`. Any move not listed is
refused.

```
intake → spec → build → gate → browser (when needed) → review → approve → merging → merged
                            └─ bot-fix → browser (when needed) → approve

intake → needs-info → intake (author reply)
intake → rejected

gate FAIL, browser FAIL, review CHANGES, bot review FAIL → build or needs-human
browser BLOCKED → needs-human
needs-human → build (human feedback) or rejected

Split parents (intake said SPLIT):

intake ──(auto_split false)──► needs-human ──(job split)──► split ──(all children merged)──► merged
  │                               │   ▲                       │
  │                               ▼   │ (feedback)            ▼
  │                             intake┘                    rejected
  └──(auto_split true, job split)──────────────────────► split
```

| Stage | Holds a slot? | What moves it on |
|---|---|---|
| `intake` | yes | intake.md `DECISION:` → `spec`, `needs-info` or `rejected`; `SPLIT` → `needs-human` (auto_split false) or, through `job split`, `split` (auto_split true) |
| `needs-info` | no | the author replies on the issue → `intake` again (old intake.md kept as `intake-<k>.md`) |
| `spec` | yes | spec.md exists → `build`, round 1 begins |
| `build` | yes | build.md `STATUS: READY` + clean tree + pushed + one open PR → `gate`; `STATUS: BLOCKED` → `needs-human` |
| `gate` | yes | checks.md `GATE: PASS` for the current commit → `browser` if needed, otherwise `review` (normal) or `approve` (bot-fix); FAIL → `build` (next round) or `needs-human` (last round) |
| `browser` | yes | browser.md `BROWSER: PASS` for the current commit → `review` (normal) or `approve` (bot-fix); FAIL → `build` (same round kind) or `needs-human` (last round); BLOCKED → `needs-human` |
| `review` | yes | every routed review present with a valid verdict; all PASS → `approve`; any CHANGES → `build` or `needs-human` |
| `approve` | yes | first `job reviews`: `REVIEWS: FAIL` → `build` (or `needs-human` on the last round), `TIMEOUT` → `needs-human`, `PASS` → the approver runs; then decision.md `APPROVE` → `merging`, `ESCALATE` → `needs-human` |
| `merging` | yes | `job merge` syncs, gates, merges → `merged`; any failure → `needs-human` |
| `needs-human` | no | `job feedback` → `build`; `job reject` → `rejected`; a human merges the PR → `merged`. For a split proposal: `job split` → `split`; `job feedback` → `intake` |
| `split` | no | a parent waiting on its children; every child job `merged` → `merged` (the parent issue closes); `job reject` → `rejected`. Only `job split` enters it |
| `merged`, `rejected` | no | terminal; the worktree and local branch are removed |

Any unfinished job moves to `merged` once its PR is merged on the forge,
whether the factory or a person merged it. `job queue` notices this.

Side effects belong to transitions, not to the orchestrator. `advance` posts
the issue comments, adds and removes labels, creates the worktree, marks the
PR ready and posts escalations, so the orchestrator never improvises them.

### `job.json` fields

| Field | Meaning |
|---|---|
| `id` | `NNN-first-four-title-words`, e.g. `004-add-dark-mode-toggle` |
| `issue`, `title`, `issue_url` | the issue (its GitLab `iid` on GitLab) |
| `pr`, `pr_url` | set when the job first passes `build → gate` |
| `branch`, `worktree` | `factory/<id>`, `<repo>/.worktrees/<id>` |
| `stage` | see above |
| `round`, `round_limit` | current round; the last allowed round |
| `intake` | parsed from intake.md: `decision`, `risk`, `surfaces`, `rescoped` |
| `agents` | `{"reviewers": {"code": "opus", ...}}`, written by `route` |
| `gate` | the current round's gate verdict |
| `browser_needed` | whether the current round needs the browser stage |
| `browser` | the current round's browser verdict: `PASS`, `FAIL`, `BLOCKED`, `pending` or `null` |
| `reviews` | `{reviewer: PASS \| CHANGES \| pending \| invalid}` |
| `cost_usd` | API-equivalent cost of the job's Claude and Codex agents |
| `started`, `ended` | timestamps; `ended` is set in waiting and terminal stages |
| `children` | on a split parent: `[{"issue", "title", "depends_on": [issue numbers]}]`, written by `job split`; otherwise null |
| `parent` | on a split child: the parent's issue number; otherwise null |

`job sync <id>` refreshes `intake`, `gate`, `browser_needed`, `browser`,
`reviews` and `cost_usd`. The files are the source of truth and `job.json`
caches their results alongside the stage.

## The job folder

```
factory/jobs/<job-id>/
  job.json                  state (only factory/bin/job writes it)
  issue.md                  the issue and trusted comments, quoted as data
  intake.md                 DECISION / RISK / SURFACES / RESCOPED, then scope, question or ## Children
  intake-<k>.md             earlier intakes, after a needs-info reply or a sent-back split
  spec.md                   title, Summary, Context, Requirements, Decisions, Testing, acceptance criteria, Assumptions
  build.md                  STATUS: READY | BLOCKED, Summary, Changes, criteria evidence, Log per round
  round-<N>/
    checks.md, checks.log           the gate's verdict and full output
    browser.md                      BROWSER: PASS | FAIL | BLOCKED for COMMIT <sha>, per-step results
    browser/                        PNG screenshots from the browser script
    merge-checks.md, merge-checks.log   the pre-merge gate (approved jobs only)
    review-<r>.md                   VERDICT: PASS | CHANGES, Findings, Notes
    reviews.md                      REVIEWS: PASS | FAIL | TIMEOUT for COMMIT <sha>, unresolved review threads
    reviews-triggered.json          which bots were pinged for which commit
  decision.md               APPROVE | ESCALATE, Why, criteria check, question for the human
  feedback-<k>.md           a human's feedback on an escalated job or a split proposal
  rejection.md              a human's reason for rejecting a waiting job
```

`issue.md` includes comments only from the issue's author and the forge user
running the factory. Anyone else's comments never reach an agent.

## Agents

All nine live in `.claude/agents/`. Under T3 their frontmatter carries only
`name` and `description`; the model comes from config, and the orchestrator
tells each child to read its file and follow it.

| Agent | Reads | Writes | First line |
|---|---|---|---|
| `intake` | issue.md, the codebase, feedback on a split | intake.md | `DECISION: ACCEPT \| NEEDS-INFO \| REJECT \| SPLIT` (+ RISK, SURFACES, RESCOPED) |
| `spec-writer` | issue.md, intake.md, the codebase | spec.md | `# <title>` |
| `builder` | AGENTS.md, spec.md, last round's checks, browser report and reviews, feedback | code, commits, PR, build.md | `STATUS: READY \| BLOCKED` |
| `browser-tester` | AGENTS.md, spec.md's Browser script, `route --browser` | round-N/browser.md, round-N/browser/ | `BROWSER: PASS \| FAIL \| BLOCKED` |
| `reviewer-code` | spec.md, build.md, the diff | round-N/review-code.md | `VERDICT: PASS \| CHANGES` |
| `reviewer-security` | same | round-N/review-security.md | `VERDICT: PASS \| CHANGES` |
| `reviewer-ux` | same, plus browser.md and screenshots | round-N/review-ux.md | `VERDICT: PASS \| CHANGES` |
| `reviewer-ui` | same, plus browser.md and screenshots | round-N/review-ui.md | `VERDICT: PASS \| CHANGES` |
| `approver` | everything above | decision.md | `APPROVE \| ESCALATE` |

What each one is for:

- **intake** is the most consequential call. Each accepted job costs a spec, a
  build and several reviews, so intake accepts only work worth building and
  fitting this project. It can cut an oversized issue down to a useful first
  slice, and it asks the author before a spec exists so the spec writer never
  stalls. It rates `risk` (low/medium/high) and `surfaces` (`ui`, `security`)
  for routing. When an issue is more than one reviewable PR, it answers SPLIT
  with a numbered list of children instead of trimming work away (see
  [Splitting large issues](#splitting-large-issues)). This copy's intake knows
  the project is a sandbox for studying and building factories.
- **spec-writer** turns the accepted scope into testable acceptance criteria.
  The criteria are the builder's test plan and every reviewer's yardstick. It
  also pins down the change's **Decisions** (the exact interfaces and contracts
  it creates, which split siblings rely on) and its **Testing** plan: the
  highest existing seam to test through (ideally one), external behaviour
  only, and the prior-art tests to follow. These ideas come from the
  `/to-spec` skill; its no-file-paths rule is deliberately not used, because a
  factory spec is read by the builder minutes later, not left in a tracker.
- **builder** implements the spec in the job's worktree, runs `checks.sh`,
  verifies criteria with tests, pushes, opens the draft PR, and keeps
  a per-round Log in build.md. Under T3 it is spawned fresh each round and
  catches up from build.md and `git log`.
- **browser-tester** runs the script in the local app and records which
  acceptance criteria it verified live.
- **reviewers** don't rerun the test suite; the gate already did. They read
  the diff for what scripts can't judge: correctness and scope (code), threats
  (security), flows, states, copy and accessibility (ux), and visual fit with
  the design system (ui). The code reviewer also fails any test that was
  weakened, skipped or special-cased to pass.
- **approver** merges only what it would merge itself and escalates the rest
  with a specific question. It always escalates changes to money, access or
  identity; deploy, CI or hosting config; schema migrations, email, production
  data or new dependencies; product decisions hiding in spec Assumptions; and,
  in this copy, any change under `.claude/` or `factory/`.

The browser-tester uses the builder's port, `ports.base + ports.step * n`
with `n` the job number. The default is `5100 + 10n`.

## Models and routing

Every model is pinned to an exact version in `factory/config.json`. Short
names like `opus` are labels inside the config only; T3 always receives the
full ID.

```json
"models": {
  "fable":  { "provider": "claudeAgent", "model": "claude-fable-5-2",  "options": { "effort": "high" } },
  "opus":   { "provider": "claudeAgent", "model": "claude-opus-5-5",   "options": { "effort": "high" } },
  "sol":    { "provider": "codex",       "model": "gpt-6.1-sol",       "options": { "reasoningEffort": "high" } },
  "terra":  { "provider": "codex",       "model": "gpt-6.1-terra",      "options": { "reasoningEffort": "xhigh" } },
  "daybreak-blue": { "provider": "codex", "model": "gpt-daybreak-blue-latest",
                     "options": { "reasoningEffort": "high", "cyberAccessProgram": "daybreakBlue" } }
}
```

Fixed roles (`roles`):

| Role | Model |
|---|---|
| intake | Fable 5.2 |
| spec-writer | Opus 5.5 |
| builder | gpt-6.1-sol, high |
| browser-tester | gpt-6.1-terra, xhigh |
| approver | Opus 5.5 |

Reviewers (`routing` by intake's risk, plus `surface_reviewers` by surface):

| | code | ux | ui | security |
|---|---|---|---|---|
| low risk | Opus 5.5 | | | |
| medium risk | Opus 5.5 | | | |
| high risk | Opus 5.5 | | | |
| + `ui` surface | | Opus 5.5 | Opus 5.5 | |
| + `security` surface | | | | Daybreak Blue, high |

Why this mix:

- Fable is called once per job, at the decision that sets the cost of
  everything after it.
- The builder is a Codex model, and the code, ux and ui reviewers are Claude,
  so the reviewer and the author come from different providers.
- The security reviewer runs on Daybreak Blue, a Codex model enrolled in the
  `daybreakBlue` cyber access program, for security-focused review.
- No review runs on Haiku. A reviewer much smaller than the builder tends to
  raise findings the builder rightly disputes, so even a low-risk change gets
  one Opus code review.

To change which model a role or reviewer runs on, run `/setup-factory`: it
detects the models T3 can spawn, shows this default beside the current setup,
and writes the choices through `factory/bin/models`, which refuses any model
this session can't spawn. To change who reviews what, edit `routing` or
`surface_reviewers`. No prompt changes.

## The scripts

### `factory/bin/job`: the state machine

```
job queue                      what /factory run should do with each labeled issue
job create <issue>             new job for an open `factory` issue; prints the job id
job advance <job> <stage>      move a job to <stage>, or refuse with the reason
job merge <job>                APPROVE → sync with main, gate, push, merge the PR
job feedback <job>             needs-human → build, with your feedback (stdin)
job reject <job>               needs-info / needs-human / split → rejected, with your reason (stdin)
job split <job>                SPLIT intake → file the child issues, park the parent in split
job reviews <job>              approve stage: PR ready, wait for the review bots on HEAD → round-N/reviews.md
job agents <job> <json>        record the routed agent set (route calls this)
job sync <job>                 refresh reviews, gate, browser and cost from the job's files
job summary [<job>...]         table: issue, stage, round, PR, cost, time
```

`<job>` is a job id or an issue number. `queue` prints one line per issue,
`action issue job stage note`, where the action is `resume`, `new`, `hold` (no
free slot, or a split child `waiting on #<m>`), `wait` (needs the author or
you, or a split parent's `children <merged>/<total> merged`) or `skip`. It enforces
`concurrency`: every job in a running stage holds a slot whether or not an
agent is on it. A per-job file lock serialises writes to each `job.json`, so
two calls on the same job can't interleave.

### `factory/bin/gate`: does it work?

`gate <job-id>` runs the **main checkout's** `factory/checks.sh` inside the
job's worktree, so a branch can't edit the checks that judge it. It also fails
any branch that modifies or deletes an existing file matching
`protected_paths` (fnmatch, where `*` matches `/`). Adding files is fine. It
writes `round-N/checks.md` (`GATE: PASS|FAIL`, `COMMIT: <sha>`) and the full
log. `advance` refuses a checks.md written for another commit, so a stale pass
can't let new code through. `gate <id> --merge` is the pre-merge run.

Tests aren't protected: features legitimately change them, and a protected
test would block the job with no way through. The code reviewer catches
weakened tests instead.

### `factory/bin/route`: who works on it?

- `route <job-id>` maps intake's risk and surfaces to the job's reviewers and
  records them in `job.json`. It refuses unknown risks, surfaces or model
  names.
- `route --target <role> [<job-id>]` prints the T3 target for one agent:
  `{"providerInstanceId", "model", "options"}`. Fixed roles need no job id;
  `reviewer-<r>` reads the job's routed reviewers. This was added for T3.
- `route --browser` prints `browser`, `review_account` and `env_files` as JSON.

### `factory/checks.sh`

It must be non-interactive, must not rewrite files, and must exit non-zero on
any failure. It validates the factory's own config and scripts, then runs the
factory's tests (`factory/tests/`, which drive the real `factory/bin/job`
against a stubbed `gh`) and the demo's tests (`demo/`). Add the project's
other commands as code arrives.

## How it runs in T3 Code

The reference spawns Claude Code subagents. This copy spawns **T3
`delegate_task` children**, which can run on any provider T3 offers.

For every agent the orchestrator:

1. Runs `factory/bin/route --target <role> [<id>]` and passes the JSON as
   `target` unchanged. If T3 reports the model unavailable, the job stops; the
   orchestrator never switches models.
2. Uses `isolation: shared`. The child starts in the main checkout and works in
   `.worktrees/<id>` by absolute path, because `factory/bin/job` owns the
   worktrees. T3's own worktree isolation would give the child a second,
   unrelated checkout.
3. Uses `mode: async` and a title like `004-dark-mode builder r2`, so each job
   shows as readable child threads in T3.
4. Writes the task as the job header, then
   `You are the factory's <role> agent. Read <repo>/.claude/agents/<role>.md in full and follow it exactly. Ignore its YAML frontmatter.`,
   then the step's own lines.

The header is:

```
Job: <id>. Job folder: <repo>/factory/jobs/<id>/. Main checkout: <repo>. Worktree: <worktree>. Branch: <branch>. Base: origin/main. Issue: #<n>.
```

`Job folder: <path>/` must stay exactly like this: cost tracking finds a
job's transcripts by that string.

Lifecycle rules:

- Every build round, browser run, review and approval is a **new child**. Finished children
  never get follow-up messages. The reference resumed one builder per job with
  `SendMessage`; here state lives in files, so a fresh builder reads build.md,
  `git log` and the round files and carries on.
- The orchestrator keeps each child's `taskId`. It cancels a job's children
  with `task_cancel` when a human merges the PR mid-run, and checks
  `task_status` once per job when resuming after a dead session, so it never
  runs two builders on one branch.
- While children run, the orchestrator doesn't poll. T3 notifies it when a
  child finishes, and it advances that job then.

## Splitting large issues

One job has one builder, on purpose: one issue is one branch, one worktree, one
gate and one PR. A large issue gets parallelism by being split **above** the
builder into child issues, each of which runs the whole pipeline on its own.

Why not trim instead? Before splitting existed, intake cut an oversized issue
down to a first slice and listed the rest in intake.md, where it was lost.
And why not several builders on one branch? They would fight over one working
tree and one `HEAD`, and the gate and reviewers judge a single change.

### How a split runs

1. **Intake decides.** It answers `DECISION: SPLIT` when the issue has two or
   more independently checkable parts and one PR would mean roughly 400+
   changed lines, unrelated areas changing together, or more acceptance
   criteria than a reviewer can hold at once. It writes 2–6 children instead of
   a Scope, cut the way the `/to-tickets` skill cuts stories:

   - **tracer bullets**: each child is a narrow but complete vertical slice,
     verifiable on its own, never a horizontal layer like "all the tests";
   - **one fresh builder each**: a child fits one context window and one review;
   - **prefactor first**: an enabling refactor is child 1, the rest depend on it;
   - **real gates only**: every needless dependency serialises parallel work;
   - **expand–contract** for wide refactors that can't land as a green slice:
     expand, then migrate in batches, then contract.

   ```markdown
   ## Children

   ### 1. Add a --shout flag
   Depends on: none
   **What to build:** uppercase the greeting when --shout is passed.

   **Acceptance criteria:**
   - [ ] `greet.py --shout Ada` prints `HELLO, ADA!`

   ### 2. Add a --lang option
   Depends on: none
   ...

   ### 3. Combine --shout with --lang
   Depends on: 1, 2
   ...
   ```

   A child may depend only on lower-numbered children, so dependencies can't
   form a cycle. `job split` refuses a list with fewer than 2 or more than 6
   children, a numbering gap, or a dependency on the same or a later child.
2. **A human confirms (by default).** With `"auto_split": false` in
   `config.json`, `job advance <id> needs-human` posts the proposed children on
   the parent issue and labels it `factory:needs-human`. Filing labeled issues
   creates queued work, and the label is the factory's trust boundary, so
   automatic filing is opt-in. You then either:
   - approve: `/factory split it`, and the orchestrator runs `job split <n>`;
   - change it: `/factory` with what you want, which becomes `feedback-<k>.md`
     and sends the job back to **intake** for a new proposal;
   - drop it: `/factory reject …`.

   With `"auto_split": true`, the orchestrator runs `job split` straight after
   intake.
3. **`job split` files the children.** For each child in order it runs
   `forge issue-create --label factory`, with a body ending in `Part of #<parent>`
   and `Depends on #<m>, …` (real issue numbers). Where the forge allows, it also
   links the child as a sub-issue of the parent; if that fails, the body
   references are enough. It records each child in the parent's `job.json`
   `children` as soon as it is created, so a crash mid-way resumes without
   duplicates. The parent moves to `split` and gets a comment listing its
   children.
4. **Children run as ordinary jobs.** Each child is a new `factory` issue, so
   `job queue` lists it. A child whose dependencies aren't all merged shows as
   `hold … waiting on #<m>` and takes no slot; `job create` refuses it too.
   Independent children come out as `new` together and run in parallel, up to
   `concurrency`. Each one gets its own intake, which may ACCEPT, ask, reject,
   or even split again. Dependencies come only from the parent's local
   `children` record, never from parsing issue bodies, which anyone with edit
   access could change.
5. **The parent closes itself.** A parent in `split` holds no slot. `job queue`
   shows `wait … children <merged>/<total> merged`, and once every child job is
   `merged` it moves the parent to `merged`, comments, and closes the parent
   issue. Rejecting a split parent leaves its children as they are.

Children that touch the same code are handled by the existing merge path:
every merge re-syncs with `main` and gates again, and a conflict escalates. The
dashboard shows a split parent with its children's stages and progress, and
each child with the parent it belongs to.

## GitHub and GitLab

The factory works on any repo whose `origin` is on GitHub or GitLab
(gitlab.com or self-hosted). Everything that talks to the host (the
"forge") goes through one script, `factory/bin/forge`; nothing else calls
`gh` or `glab`. `factory/FORGE.md` is its contract.

| | GitHub | GitLab |
|---|---|---|
| CLI the backend uses | `gh` | `glab` (`glab api`, REST v4) |
| Config | `"forge": {"type": "github", "host": "github.com", "project": "owner/repo"}` | `"forge": {"type": "gitlab", "host": "gitlab.com", "project": "group/sub/project"}` |
| "PR" | pull request | merge request; numbers are `iid`s |
| Review threads | PR review threads | resolvable MR discussions |
| Draft → ready | `gh pr ready` | clear the MR's draft flag |
| Child links (splits) | sub-issues | related issues (best effort) |
| Default review bots | Codex, Greptile | none until configured |

The installer detects the forge from `origin`, checks the right CLI and
permissions (Developer access or above on GitLab), and writes `forge`. A
config without `forge` is GitHub, so installs from before this keep working.
Adding another provider means adding one backend class to `factory/bin/forge`.

## Review bots

Review bots (Codex and Greptile on GitHub; whichever the project lists on
GitLab) review the factory's PRs. The list is `config.json` `review_bots`
(older installs: `github_reviews`, still read). They review only PRs
that are ready for review, so the factory used to get their verdict seconds
after it had already merged. Now their review is a gate in the approve stage,
before the approver runs.

1. **`job reviews <id>`** marks the PR ready, then waits (polling every
   `poll_seconds`, up to `timeout_minutes`) until every bot in
   `config.json` `review_bots.bots` has reviewed the PR's **current
   commit**. A review counts when it was submitted on that commit, or, for
   Codex, when its summary comment's `codex-review-state:v1` says
   `code_review.commit_sha` is that commit and `status` is `completed`. A bot
   that hasn't reviewed the commit gets its `trigger` comment (`@codex
   review`, `@greptileai review`) once per commit.
2. It then counts **unresolved review threads from anyone**, bot or person,
   and writes `round-<N>/reviews.md`: `REVIEWS: PASS`, `FAIL` (with every
   unresolved thread's path, line, comment, URL and thread id) or `TIMEOUT`
   (naming the bots that never reviewed).
3. **FAIL sends the job back to the builder** for a new round, which counts
   toward `max_rounds`. The builder either fixes each thread (and replies with
   the commit) or answers it with a concrete reason, then resolves it. The
   next round goes through the gate, the browser stage when needed, and this
   step again, because the bots review the new commit.
4. **PASS lets the approver run.** The approver also reads `reviews.md` and
   the threads earlier rounds resolved, and treats a weakly answered thread as
   a real problem.
5. **`job merge` is the backstop.** It requires `REVIEWS: PASS` for the current
   commit or an ancestor followed only by base-branch commits and merge commits,
   and re-queries threads just before merging the PR; a new
   unresolved thread sends the job to `needs-human` instead of merging.

Bots are listed by login in config; GraphQL logins have no `[bot]` suffix.
TIMEOUT usually means a bot isn't installed or didn't trigger: check the PR,
then re-run `job reviews`.

## Guardrails

- Only issues labeled `factory` run. `job create` refuses unlabeled issues.
- Issue text reaches agents only as quoted data in `issue.md`, never pasted
  into a task. Only the author's and the operator's comments are included.
- Agents push only their own `factory/<job-id>` branch. Only
  `factory/bin/job merge` merges, through the forge's own merge, so branch protection
  and required checks apply. The factory never deploys.
- Before merging, the branch is synced with `main` and gated again, because
  another job may have merged since it was tested. A conflict or failure
  escalates.
- One PR per issue; at most `max_rounds` rounds before a human is asked.
- Only `job split` files child issues, only from a SPLIT intake, and with
  `auto_split` false only after a human approves.
- The checks and config are protected paths, so no job can loosen them.
- No PR merges before every configured review bot has reviewed its
  current commit (or an ancestor followed only by base-branch commits and merge
  commits), or with any review thread unresolved.

## What the T3 edition gave up

These are the real costs of moving from native subagents to T3 children.
Close them first if you build on this.

| Lost | Reference | Here | Mitigation today |
|---|---|---|---|
| **Tool limits** | Frontmatter `tools:` gave intake no shell and reviewers no Edit | Every child has full tools | Instructions name the files each agent may write. Scripts refuse illegal state moves. |
| **Intake has a shell** | Intake read untrusted issue text without Bash, so a prompt injection couldn't run commands | Intake can run commands | The label is still the trust boundary: only triage/write users can queue an issue |
| **Builder stop hook** | A `SubagentStop` hook ran `checks.sh` before the builder could finish | No hook (`gate --hook` is unused) | The task tells the builder to pass the checks before replying READY; the gate still decides |
| **Builder memory** | One builder per job, resumed each round | A fresh builder per round | build.md's per-round Log and `git log` carry the history |

## Job cost

`job sync` reads native Claude subagent and T3 Claude child transcripts under
`~/.claude/projects/<repo>/` (or `CLAUDE_CONFIG_DIR`). It reads T3 Codex rollouts
under `sessions/` and `archived_sessions/` in `CODEX_HOME` (default
`~/.codex`). T3's Codex shadow home shares those directories with its
configured Codex home. Set `CODEX_HOME` for the job command if T3 uses a
custom home.

The first recorded Codex task must contain the matching job header and
absolute job-folder path. Each fresh T3 child has one model and one session
ID. Cost uses the largest cumulative `total_token_usage` snapshot per session
ID, including when the same rollout appears in the active and archive
directories. Cached reads and writes are part of input tokens and receive
their own rates. Output tokens already include reasoning.

The job command caches parsed rollout usage in `factory/jobs/.codex-rollouts.json`
and refreshes it when rollouts change. The cache is safe to delete.

The dashboard and `job summary` show estimates based on
`prices_usd_per_mtok` in `factory/config.json`. The Codex rates use
OpenAI's standard short-context text prices and the 30-minute cache-write
rate. The estimate excludes service-tier and long-context adjustments.
`gpt-daybreak-blue-latest` uses the published GPT-5.6 Sol rates. The configured
rates apply to historical rollouts as well. See
[GPT-6.1 Sol pricing](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[Daybreak Blue alias](https://developers.openai.com/api/docs/models/gpt-daybreak-blue-latest),
and [GPT-5.6 Sol pricing](https://developers.openai.com/api/docs/models/gpt-5.6-sol).

Cost depends on the rollouts available locally and their on-disk format. The
job command reports an error when a matching session has usage but its model
has no configured price, or when it cannot identify a single Codex model.
`install.sh --update` preserves an existing price table. Copy the Codex rate
entries from this repo when updating a factory installation with a
Claude-only table.

## Operating it

```
/factory run          drain the queue: every open `factory` issue, `concurrency` at a time; also resumes
/factory run <n>      one issue now
/factory <anything>   ask about jobs, give feedback, reject a waiting job, or file a feature
```

- **Start carefully:** set `concurrency` to 1 and read every PR until you trust
  it.
- **Approve** an escalated PR by merging it on GitHub (or the MR on GitLab).
- **Change** an escalated PR with `/factory` and what you want; it becomes
  `feedback-<k>.md` and a new round.
- **Split** proposals wait as `needs-human`: approve with `/factory split it`,
  or describe a different split and intake proposes again. Set
  `"auto_split": true` in `config.json` once you trust intake's splits.
- **Drop** a job waiting on you or its author, or a split parent, by telling
  the factory to reject it. The reason goes on the issue and the PR closes. To retry later,
  delete `factory/jobs/<id>` and label the issue again.
- **Resume** after a crash with `/factory run`; every job picks up from its
  stage.
- **Dashboard:** `/factory run` starts it and opens it in T3's preview pane:
  `factory/bin/dashboard start` runs `python3 -m http.server` as a detached
  process (its own session, pid and log in `factory/jobs/`), so it keeps
  running after the Claude session or a background-task time limit ends, until
  `factory/bin/dashboard stop` or a reboot. It reuses a dashboard already
  serving on the port. Configure with `"dashboard": {"port": 8000, "open":
  true}`; `"open": false` turns the auto-start off.
- **Cost:** Fable can bill to usage credits instead of the plan's included
  usage. Cost figures are API-equivalent, not your bill.

## Installing into another project

`install.sh` at the root of the factory's repo installs it into any repo with
a GitHub or GitLab `origin`. Run it in the **root of the target repo** (step-by-step,
including access to the private source repo, in the factory repo's
`README.md` under "Install into another repository"):

```bash
gh api repos/joshuaManlunas/agentic-software-factory/contents/install.sh \
  -H "Accept: application/vnd.github.raw" | bash        # add: | bash -s -- --update
```

It splits the work the same way the factory does: a script for what's
deterministic, an agent for what needs judgment.

| Step | Who | What |
|---|---|---|
| Preflight | `install.sh` | git repo with a GitHub or GitLab origin, `gh` (to fetch the factory) and, for GitLab, `glab` authenticated with Developer access, `python3` 3.10+; refuses to install over an existing factory (use `--update`) or into its own source repo |
| Copy | `install.sh` | the engine (skill, `factory/bin/*`, dashboard, factory tests, `ADAPT.md`, this doc as `factory/FACTORY.md`) and the project files (agents, `config.json`, `checks.sh`, `.greptile/config.json` when Greptile is a review bot) |
| Configure | `install.sh` | `forge` (provider, host, project) from `origin`; `base_branch` and `merge_method` from the repo's settings on that forge, review bots from `--review-bots`, `concurrency` 1 for a careful start; intake's project paragraph becomes a `TODO`; `checks.sh` becomes a template that fails until filled |
| Wire up | `install.sh` | `.gitignore` lines, the `## Software factory` section in `AGENTS.md`/`CLAUDE.md`, the three labels, `factory/.installed.json` (source, ref, commit) |
| Adapt | an agent following `factory/ADAPT.md` | the project's real checks, intake's project line, reviewer hot spots, approver escalations, agent docs; then verifies `checks.sh` passes |

**Engine vs project files.** `--update` replaces only engine files, so a newer
factory can be pulled in without losing a project's tailoring. It never
overwrites the agents, `config.json` or `checks.sh`; it adds agent files and
top-level config keys that are new in the newer version. Project-specific text
inside a shipped file sits between `<!-- factory:project -->` markers.

**Private source.** The installer fetches with `gh repo clone`, so anyone with
read access to the factory's repo can install from it, private or not.
`FACTORY_SOURCE_DIR=<path>` installs from a local checkout instead (what the
installer's tests use).

## Building your own

The factory has a few seams; most changes land in exactly one.

| To change | Edit | Leave alone |
|---|---|---|
| What gets built | `intake.md`'s project line and Decide rules | the pipeline |
| When and how issues split | intake's SPLIT rule and threshold; `auto_split` | `job split` |
| Who reviews what | `routing` / `surface_reviewers` in config | prompts |
| Which model plays a role | `models` / `roles` in config | the scripts |
| What "works" means | `checks.sh`, `protected_paths` | reviewers |
| What a human must see | the approver's ESCALATE list | the merge path |
| A new reviewer lens | a new `reviewer-<r>.md` with the same output format, plus a `surface_reviewers` entry and an intake surface | the state machine |
| A new stage | `TRANSITIONS` and `advance` in `job`, then the skill's step | everything else |

Principles worth keeping in any version:

1. **One writer for state.** Agents write their reports. Only a script moves
   the job, and it checks the files that justify the move.
2. **First lines are the API.** Machine-readable first lines let a small
   orchestrator run many jobs without reading everything.
3. **Scripts before opinions.** Run the deterministic gate before spending
   reviewer tokens, and again before merging.
4. **Judge with what the branch can't change.** Checks from the main checkout,
   protected config, approval through the forge.
5. **Files over memory.** Everything needed to resume is on disk, which is
   what lets T3 children be disposable.
6. **Spend judgment where it compounds.** The strongest model at the door,
   cheap reviewers for low risk, a human only for real decisions.

Open problems in this copy, roughly in order of value:

- Restore tool limits per role. T3 `runtimeMode` gates approvals, not tools,
  so this probably needs read-only instructions enforced by a check, or a
  provider-side sandbox.
- Run intake without a shell again, since it reads untrusted text.
- Let a split child see its siblings' merged code before its own intake, so
  dependent children are scoped against what actually landed.
