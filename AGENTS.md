# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `bunx ultracite fix`
- **Check for issues**: `bunx ultracite check`
- **Diagnose setup**: `bunx ultracite doctor`

Oxlint + Oxfmt (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**

- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**

- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**

- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Oxlint + Oxfmt Can't Help

Oxlint + Oxfmt will catch most mechanical issues automatically. Focus your attention on:

1. **Business logic correctness** - Oxlint + Oxfmt can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Oxlint + Oxfmt. Run `bunx ultracite fix` before committing to ensure compliance.

## Development

**Fresh checkout.** `bun install --frozen-lockfile`. Env is validated by Varlock against `apps/web/.env.schema`; values live in the gitignored `apps/web/.env` (`NODE_ENV`, `BETTER_AUTH_SECRET` (32+ chars), `BETTER_AUTH_URL`, `DATABASE_URL`, `VAULT_MASTER_KEY` (base64 for 32 bytes; not required by Varlock when `NODE_ENV=test`, but the server refuses to start without a valid one)). A worktree has no `.env`: copy it from the main checkout, or export the non-secret local defaults that `factory/checks.sh` uses. Postgres: `bun run db:start` (docker-compose, `postgres:password@localhost:5432/jomans-vault`); schema changes go through `bun run db:generate` then `bun run db:migrate`.

After pulling a change that adds a migration, update the local database with `bun run db:migrate`.

**CLI.** `bun run build:cli` builds the executable `apps/cli/dist/jv`. `jv ls`, `jv get`, `jv set`, `jv rm` and `jv history` list, read, store, remove and inspect secrets; `jv get` prints only the value. CLI tests drive terminal-only behaviour through `runJvInTerminal` in the test harness, build the binary first, require Postgres, and never touch the real keychain: they use `JV_TEST_KEYCHAIN`. The config directory is `$XDG_CONFIG_HOME/jv` when absolute, otherwise `~/.config/jv`. `jv.json` is found in the nearest directory upward, holds only project/environment slugs and an optional URL and is safe to commit; `jv run` injects values without writing them to disk.

**Dev server.** `bun run dev:web -- --port <port>` starts the web app (default port 3001). The docs site: `cd apps/fumadocs && bun run dev -- --port <port>` (default 4000).

**Validation** (what `factory/checks.sh` runs, from the repo root): `bun run check` (lint + format), `bun run check-types`, `bun run build`, and `bun run test`, which runs `bun test` in every package with a `test` script. The crypto tests need no database; the api package tests need Postgres up and create and drop their own database.

<!-- factory:section -->

## Software factory

`/factory run` builds every open GitHub issue labeled `factory` through intake → spec → build → gate → review → GitHub reviews → approve, one PR per issue. State is in `factory/jobs/` (gitignored); `factory/bin/job` is its only writer. Checks: `factory/checks.sh`. How it works: `factory/FACTORY.md`. Dashboard: `cd factory && python3 -m http.server`, then open http://localhost:8000/dashboard.html. Each job works in its own git worktree at `.worktrees/<job-id>` (gitignored); tools run from the repo root that don't read `.gitignore` should exclude `.worktrees/`.
<!-- /factory:section -->

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.
