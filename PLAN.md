# jomans-vault: implementation plan

An online secret store, inspired by HashiCorp Vault, used by agents and humans alike. Agents get a simple API to get, set, update, and remove secrets, env var values, and tokens. Local development pulls them at run time, so nothing sensitive is saved on the dev machine.

## Starting point (what the scaffold already gives us)

Better-T-Stack monorepo (Bun 1.4.4, Turborepo, TanStack Start, oRPC, Drizzle + Postgres 18, Better Auth 1.7.12, Varlock, Ultracite).

| Piece | Where | What it does today |
|---|---|---|
| Web app + server | `apps/web` | TanStack Start. Mounts Better Auth at `src/routes/api/auth/$.ts` and oRPC at `src/routes/api/rpc/$.ts` (an RPC handler, plus an OpenAPI handler under `/api/rpc/api-reference`). The `_auth/` route group redirects to `/login` when there's no session. |
| API layer | `packages/api` | `publicProcedure` and `protectedProcedure`, which requires a session. The router has only `healthCheck` and `privateData`. Context is `{ session, db }`. |
| Auth | `packages/auth` | `createAuth()`: email and password, Drizzle adapter, `tanstackStartCookies`. No plugins for machine auth yet. |
| Database | `packages/db` | `createDb()`, plus the Better Auth tables in `src/schema/auth.ts`. No migrations yet (`src/migrations/.gitkeep`). |
| UI kit | `packages/ui` | shadcn primitives (button, card, input, dropdown-menu, …). No table or dialog yet. |
| Docs | `apps/fumadocs` | Docs site, with only placeholder pages so far. |
| Env | `apps/web/.env.schema`, `packages/db/.env.schema` | Varlock schemas. Secrets currently live in the gitignored `apps/web/.env`. |
| Runtime | `docker-compose.yml` | `web` (port 3001) and `postgres`. |

Two things in the scaffold shape the plan:

1. **oRPC already serves OpenAPI.** One router can serve the typed web client and a plain REST and JSON surface that agents can call with `curl`. No second API stack is needed.
2. **Varlock already owns env loading.** Varlock supports resolver plugins (for example, `op()` for 1Password) and an `exec()` fallback. So "don't store secrets locally" can mean a committed `.env.schema` that says `DATABASE_URL=jv(...)`, with the value fetched from jomans-vault at run time.

---

## 1. Data model

**Extends `packages/db`**: adds a new `src/schema/vault.ts`, exported from `src/schema/index.ts`, with its relations added in `src/relations.ts`.

```
project            id, slug (unique per owner), name, ownerId → user.id, createdAt, updatedAt
environment        id, projectId → project, slug ("development" | "staging" | "production" | custom), createdAt
                   unique (projectId, slug)
secret             id, environmentId → environment, key ("DATABASE_URL"), kind ("secret" | "env" | "token"),
                   description, currentVersionId → secret_version, deletedAt (soft delete), createdAt, updatedAt
                   unique (environmentId, key) where deletedAt is null
secret_version     id, secretId → secret, version (int, monotonic per secret), ciphertext (bytea), iv (bytea),
                   createdByType ("user" | "apiKey"), createdById, createdAt
project_key        id, projectId → project, wrappedDek (bytea), iv, kekVersion, createdAt, retiredAt
audit_event        id, projectId, environmentId?, secretId?, action ("secret.read" | "secret.reveal" |
                   "secret.export" | "secret.write" | "secret.delete" | "apikey.create" | …), actorType, actorId,
                   ip, userAgent, createdAt   -- never the value
```

The `apikey` table comes from the Better Auth API key plugin (see §3). It's generated into `packages/db/src/schema/auth.ts` by the existing `bun run auth:generate` script, not written by hand.

**Encryption (envelope).**
- One data encryption key (DEK) per project. The DEK is stored only in wrapped form in `project_key`.
- A key encryption key (KEK) wraps the DEKs. It comes from a new `VAULT_MASTER_KEY` item in `apps/web/.env.schema` (`@sensitive`, 32 bytes, base64).
- Values are encrypted with AES-256-GCM using Web Crypto (built into Bun and Node, so no new dependency).
- Postgres only ever sees ciphertext. Logs and audit events never contain values.
- `kekVersion` lets the KEK rotate later, and a KMS can replace the env var later.
- The crypto lives in a new **`packages/crypto`**: pure functions `wrapDek`, `unwrapDek`, `encryptValue`, `decryptValue`. The API layer calls it, and it's the easiest part to test in isolation.

**Versioning.** Every set or update writes a new `secret_version` and moves `currentVersionId`. Delete is a soft delete. This gives rollback and history for free, and protects against an agent overwriting a value by mistake.

**Migrations.** Use `bun run db:generate`, then `db:migrate`, for these tables, not `db:push`. Real migrations matter once real secrets are stored.

## 2. Agent-facing API (get / set / update / remove)

**Extends `packages/api`**: adds `src/routers/projects.ts`, `src/routers/environments.ts`, `src/routers/secrets.ts`, and `src/routers/api-keys.ts`, all mounted in `src/routers/index.ts`.

**Extends `apps/web`**: adds a dedicated route `src/routes/api/v1/$.ts` that runs the existing `OpenAPIHandler` with prefix `/api/v1`. This gives agents clean REST paths, unlike today's `/api/rpc/api-reference` prefix. The current `/api/rpc` stays for the web UI's typed client.

Every procedure declares `.route({ method, path })` so it appears in the OpenAPI spec:

| Operation | Method and path | Notes |
|---|---|---|
| List keys | `GET /api/v1/projects/{project}/envs/{env}/secrets` | Returns keys, kind, version, and updatedAt only, never values |
| Get one | `GET /api/v1/projects/{project}/envs/{env}/secrets/{key}` | Returns `{ key, value, version }`. Requires the `reveal` permission. Audited as `secret.reveal` |
| Set (create or overwrite) | `PUT /api/v1/projects/{project}/envs/{env}/secrets/{key}` | Body `{ value, kind?, description? }`. Writes a new version |
| Update (safe) | `PATCH …/secrets/{key}` | Body `{ value, expectedVersion }`. Returns 409 if someone changed it first |
| Remove | `DELETE …/secrets/{key}` | Soft delete. Later versions can restore it |
| Bulk export | `GET …/envs/{env}/export?format=dotenv\|json` | What the CLI and Varlock plugin use to inject a whole environment in one call. Returns plaintext, so it requires the `inject` permission. Audited as `secret.export` |
| History / rollback | `GET …/secrets/{key}/versions`, `POST …/secrets/{key}/rollback` | Rollback takes `{ version }` |
| Projects / envs | CRUD under `/api/v1/projects` | Human sessions by default (see §3) |

Zod input schemas define the shape of a key: `^[A-Z_][A-Z0-9_]*$`, plus a maximum value size. They feed both validation and the generated OpenAPI spec.

**Changes to `packages/api/src/index.ts` and `context.ts`.** Replace `session: Session | null` with a `principal`:
- `{ type: "user", user }`, or
- `{ type: "apiKey", keyId, userId, scopes }`.

Then add these middlewares:
- `authedProcedure`: the caller is either a user or an API key.
- `requireScope(project, env, action)`: checks the key's scope (or the user's ownership) for the project or environment named in the input.
- `audit(action)`: writes an `audit_event` after the handler succeeds.

`apps/web/src/context.ts` builds the principal. It reads `Authorization: Bearer <key>` (or `x-api-key`) and verifies it through Better Auth. Otherwise it falls back to the session cookie, as it does today.

## 3. Authentication: humans and agents

**Humans (existing, unchanged):** Better Auth email and password and the session cookie (`packages/auth`, `apps/web` login and sign-up forms, the `_auth/` route guard).

**Agents and the CLI (new):** in `packages/auth`, add the Better Auth API key plugin (`@better-auth/api-key`, pinned to the same 1.7.x as `better-auth`) and register it in `createAuth()`.

```ts
apiKey({ defaultPrefix: "jv_", permissions: { defaultPermissions: { secrets: ["read"] } } })
```

- Keys belong to the user who creates them. Permissions use the plugin's `{ resource: actions[] }` shape: `secrets: ["read", "reveal", "inject", "write", "delete"]`. Two of these hand plaintext to the caller: `reveal` (one value through `GET …/secrets/{key}`) and `inject` (a whole environment through `/export`). Both are off by default. A key with neither can list keys and write values, but never reads them back.
- Project and environment scope is stored in the key's metadata, for example `{ projects: { "my-app": ["development"] } }`. `requireScope` enforces it, because the plugin's permission model knows actions but not our projects.
- Keys are shown once at creation. The plugin stores only a hash. Keys can expire and be revoked from the UI.
- Run `bun run auth:generate` after adding the plugin, then generate and apply a migration.

**CLI login:** `jv login` opens the browser to `/cli/authorize`, a new `apps/web` route under `_auth/`. There the signed-in human approves a scoped key for that machine. The key goes into the OS credential store, never into a dotfile (see §4).

## 4. Local development without secrets on disk

Two ways in, both new:

**a) `apps/cli`, a new Bun CLI named `jv`, shipped as a single binary via `bun build --compile`.** It talks to `/api/v1` and uses the generated oRPC or OpenAPI client types from `packages/api`.

```
jv login                              # browser approval → scoped key stored in OS keychain
jv link my-app --env development      # writes jv.json {project, env}: ids only, no secrets, safe to commit
jv run -- bun run dev                 # fetches /export, injects into the child's env, nothing written to disk
jv get KEY | jv set KEY [value|-] | jv rm KEY | jv ls | jv history KEY
```

`jv run` is how agents should normally consume secrets. The values go straight into the child process's environment rather than being printed, so they don't end up in the agent's transcript or context by accident.

This is protection against accidental exposure, not a security boundary. The caller chooses the command, so `jv run -- env` (or a script that logs its environment) prints every injected value. `jv run` needs a key with the `inject` permission, and anyone holding that key can read plaintext. Treat the child command as trusted, and give `inject` only to keys whose commands you trust, scoped to the environments they need.

**b) `packages/varlock-plugin`, a new Varlock plugin that registers an `@initJv(...)` root decorator and a `jv()` resolver.** It reuses the CLI's stored credential.

```env-spec
# @plugin(@jomans-vault/varlock-plugin)
# @initJv(project=jomans-vault, env=$NODE_ENV)
# ---
# @sensitive
BETTER_AUTH_SECRET=jv(BETTER_AUTH_SECRET)
```

This fits the repo's existing Varlock setup (`@varlock/vite-integration` in `apps/web`, and `varlock run` in the `auth:generate` script). A committed `.env.schema` then becomes the whole env definition, and `apps/web/.env` can go away.

**Phase-1 shortcut:** before the plugin exists, Varlock's built-in `exec()` already works:

```env-spec
DATABASE_URL=exec(`jv get DATABASE_URL`)
```

**Bootstrap caveat:** the vault server itself can't fetch its own `DATABASE_URL` and `VAULT_MASTER_KEY` from itself. Those two stay in the deployment environment (`docker-compose.yml` env or host secrets). Every other project, including this repo's own dev setup once a vault instance is running, can use `jv`.

## 5. Human UI

**Extends `apps/web`**: new routes under `src/routes/_auth/`, replacing the placeholder `dashboard.tsx`:

- `projects/index.tsx`: the project list, with a "new project" button.
- `projects/$project/$env.tsx`: a secrets table with masked values, click-to-reveal (audited), add/edit/delete, a version history drawer, and an environment switcher.
- `settings/api-keys.tsx`: create a scoped key (shown once), list keys, revoke.
- `audit.tsx`: the audit log, filterable by project and actor.
- `cli/authorize.tsx`: the approval screen for `jv login`.

**Extends `packages/ui`**: add `table`, `dialog`, `sheet`, `select`, and `badge` via `npx shadcn@latest add … -c packages/ui`, as the README describes.

## 6. Docs

**Extends `apps/fumadocs`**: replace `content/docs/index.mdx` and `test.mdx` with:
- Quickstart: human.
- Quickstart: agent, with a copy-paste curl example and a "use `jv run`, don't read values" guideline that spells out that `inject` is still plaintext access and only trusted commands should run under it.
- CLI reference.
- Varlock plugin.
- API reference, linked from or embedded via the generated OpenAPI spec.
- Security model: encryption, scopes, audit.

## 7. Deployment

**Extends `docker-compose.yml`**:
- Pass `VAULT_MASTER_KEY` to `web`.
- Keep Postgres unexposed in production (port 5432 is published today for local dev).
- Document backups. A lost KEK means every stored value is lost.

**Extends `turbo.json`**: add `VAULT_MASTER_KEY` to `globalEnv`.

## 8. Testing

There's no test runner in the repo yet. Add `bun test` to `packages/crypto` and `packages/api`, with a small set of tests that would actually go red if something broke:
- Round-trip: encrypt then decrypt returns the original value, and a tampered ciphertext or IV is rejected (GCM auth).
- Scope enforcement, as one table-driven test: a key scoped to `my-app/development` gets 403 on `production` and on another project, a key without `reveal` can list but not get, and a key without `inject` gets 403 on `/export`.
- `PATCH` with a stale `expectedVersion` returns 409 and doesn't write a version.
- Delete, then list: the key is gone, and its history is still readable.
- No value appears in any `audit_event` row.

The API tests should run against the dockerized Postgres (`bun run db:start`), not mocks.

## 9. Phases

1. **Core vault**: `packages/crypto`, the vault schema and migrations, the secrets and projects routers, the `/api/v1` OpenAPI route, and the human UI for projects and secrets.
2. **Agents**: the API key plugin, scopes, the `reveal` and `inject` permissions, the audit log, and the API keys UI.
3. **Local dev**: the `apps/cli` `jv` binary (`login`, `link`, `run`, `get`/`set`/`rm`), plus the `exec()` recipe. Dogfood it on this repo.
4. **Polish**: the Varlock plugin, version rollback UI, docs, and an MCP endpoint (see Q6).

---

## Decisions (accepted 2026-11-14)

All eight recommendations below were accepted as written. Q8 still has a check to do before the CLI is built.

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | **Who can access which secrets?** Personal projects only, or teams/orgs from day one? | Personal: each project has one `ownerId`. Add Better Auth's `organization` plugin later | You're the first user. The `requireScope` middleware is the one place that would change, so adding orgs later is cheap. |
| Q2 | **How do agents authenticate?** | Better Auth API keys scoped to project, environment, and actions, created by a human | It's already in the auth stack, keys are hashed at rest, and expiry and revocation are built in. OAuth client-credentials would be overkill for one owner. |
| Q3 | **Can agents read plaintext values?** | Only with an explicit permission, off by default: `reveal` for one value, `inject` for a whole environment (what `jv run` uses). Agents normally consume secrets through `jv run` | Anything an agent reads ends up in its context, logs, and transcripts. Injection avoids accidental exposure, but it doesn't stop an agent that runs `jv run -- env`. So `inject` counts as plaintext access, and should go only to keys whose commands you trust. |
| Q4 | **How are secrets delivered at local dev time?** | `jv run -- <cmd>` first, then the Varlock `jv()` plugin. Values exist only in process memory | `jv run` works with any tool. The plugin fits this repo's existing Varlock setup and keeps `.env.schema` as the single source. |
| Q5 | **Where does the master key (KEK) live?** | The `VAULT_MASTER_KEY` env var now, with `kekVersion` in place so a KMS can replace it later | It's simple to self-host, and the rotation path is already in the schema. |
| Q6 | **Expose an MCP server for agents?** | Yes, in phase 4, as an `apps/web` route over the same routers, offering `list`, `set`, and `run`-style tools but no raw `get` by default | Agents can use REST today, but MCP makes discovery easy. Leaving out raw `get` cuts accidental exposure. The `run` tool still needs `inject`, so the trust caveat in Q3 applies. |
| Q7 | **Hosting?** | Self-host with the existing `docker-compose.yml` on a box you control | No new infrastructure, and the secrets stay with you. |
| Q8 | **Where does the CLI keep its credential?** | The OS keychain (Keychain on macOS) via Bun's secrets API. Check that this API exists in Bun 1.4 before relying on it, and fall back to a `0600` file only if it doesn't | This matches the goal of no secrets in local files. |
