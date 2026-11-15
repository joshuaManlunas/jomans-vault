# Forge interface

The factory talks to its source-control host (the "forge": GitHub, GitLab, …)
only through `factory/bin/forge`. Nothing else calls `gh` or `glab` directly:
not `factory/bin/job`, not the agents, not the orchestrator. Adding a provider
means adding one backend class in `factory/bin/forge`.

## Configuration

`factory/config.json`:

```json
"forge": { "type": "github", "host": "github.com", "project": "owner/repo" }
"forge": { "type": "gitlab", "host": "gitlab.com", "project": "group/subgroup/project" }
```

- `type`: `github` (backend uses `gh`) or `gitlab` (backend uses `glab`, which
  also covers self-hosted GitLab via `host`).
- `project`: the full path on that host. GitLab paths may have subgroups.
- A config without `forge` is treated as GitHub with the project resolved from
  `origin` (installs made before this existed keep working).
- `review_bots` replaces `github_reviews` (same shape: `bots`,
  `timeout_minutes`, `poll_seconds`). `github_reviews` is still read when
  `review_bots` is absent.

The installer writes `forge` from the target repo's `origin` URL.

## Vocabulary

The factory says **PR** everywhere; on GitLab a PR is a merge request (MR) and
its number is the MR `iid`. Issue numbers are the GitLab issue `iid`. Every
command takes and returns these numbers, never global ids. Logins are compared
without a trailing `[bot]`.

## Commands

Run as `factory/bin/forge <command> [args]`. Output is JSON on stdout (or
nothing); errors go to stderr with a non-zero exit. Long text (bodies) is read
from stdin where marked `<stdin`. `factory/bin/job` imports the same module
and calls the same functions instead of shelling out.

| Command | Returns / does |
|---|---|
| `whoami` | `{"login"}` of the authenticated user |
| `repo` | `{"project", "url", "default_branch", "merge_methods": ["merge"\|"squash"\|"rebase"…], "can_push": bool}` |
| `issue-list --label L --state open` | `[{"number", "title"}]` |
| `issue-view N` | `{"number", "title", "body", "author", "labels": [..], "state": "OPEN"\|"CLOSED", "url", "comments": [{"author", "body", "created_at"}]}` |
| `issue-create --title T --label L… <stdin` | `{"number", "url"}` |
| `issue-comment N <stdin` | posts a comment |
| `issue-labels N [--add L,…] [--remove L,…]` | edits labels |
| `issue-close N` | closes the issue |
| `issue-link-child PARENT CHILD` | best-effort parent/child link (GitHub sub-issue, GitLab related issue); exit 0 even if unsupported, note on stderr |
| `label-ensure NAME COLOR DESCRIPTION` | creates the label if missing |
| `pr-for-branch BRANCH [--state open\|all]` | `[{"number", "url", "state"}]` |
| `pr-view N` | `{"number", "url", "state": "OPEN"\|"MERGED"\|"CLOSED", "draft": bool, "head_sha", "head_branch", "base_branch"}` |
| `pr-create --base B --head H --title T [--draft] <stdin` | `{"number", "url"}` (body from stdin; it should contain `Closes #<issue>`) |
| `pr-ready N` | marks the PR ready for review (no-op if it isn't a draft) |
| `pr-comment N <stdin` | posts a top-level comment |
| `pr-merge N --method merge\|squash\|rebase` | merges |
| `pr-close N` | closes without merging |
| `threads N [--unresolved]` | `[{"id", "resolved", "path", "line", "author", "body", "url", "comment_id"}]`: review threads (GitHub) / resolvable discussions (GitLab) |
| `thread-reply N THREAD_ID <stdin` | replies inside the thread |
| `thread-resolve N THREAD_ID` | marks the thread resolved |
| `bot-reviewed N LOGIN SHA` | `{"reviewed": bool}`: has that bot reviewed commit SHA of the PR |

Labels on GitLab are scoped by project; colours are `#RRGGBB` on both.
