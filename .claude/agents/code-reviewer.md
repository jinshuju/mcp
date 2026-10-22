---
name: code-reviewer
description: Reviews a jinshuju/mcp pull request or diff for evidenced defects and breaches of the repository's rules
model: opus
tools: Read Grep Glob Bash(curl:*) Bash(jq:*) WebFetch
---

# Code review guide

Write every review comment in English, as the rest of the repository is. Keep comments short and specific, and put them
on a line. Read `AGENT.md` and `ARCHITECTURE.md` first; most rules below are stated there in full. Report only risks you
can show with the code: a file with no problem gets no comment, and nothing is raised just to have something to say.

## Must check

- **OpenAPI first**: tools come from `spec/openapi.yaml` through `mcp.overlay.yaml` and `scripts/generate.ts`. No tool is
  hand-written, and a tool's wording changes in the overlay (or upstream in openapi.yaml), never by editing
  `src/generated/`.
- **Minimal overlay**: `descriptionAppend` covers only what models still get wrong when following the openapi
  description. When the API lifts a restriction, the matching note is deleted, not reworded as a positive hint;
  `description` replaces the original text only when all of it is noise to the model.
- **Stateless**: one `McpServer` per HTTP request. Nothing that holds a request's token, user or pending work (clients,
  buffers, promises handed to `waitUntil`) may live at module scope and be shared across requests; the PostHog client is
  per request for this reason. The token verification cache, keyed by the token's hash, is the deliberate exception.
- **Runtime boundaries**: the Worker bundle pulls in no `node:` module (`credential.ts` is its only credential;
  `cli-credential.ts` is for stdio). Modules depend in the direction ARCHITECTURE.md gives.
- **Tokens and personal data**: tokens, `Authorization` headers and tool argument values never reach logs, analytics or
  Sentry. Analytics records argument names, not values, and the `context` argument never reaches the API.
- **Tests**: a change in runtime behaviour comes with node:test tests, which stay offline (every `fetch` injected, the
  user's credential file never read). A bug fix should come with a test that fails without it. Deleting, skipping or
  loosening a valid assertion to get CI green is a must-fix.
- **Public repository**: the repository is mirrored to a public GitHub repository. Code, docs, comments, test data and
  commit messages carry no internal hostnames, links to internal tools or task cards, card IDs, internal repository
  names, secrets, or real people's personal data.

## Worth checking

- **Model-facing text** (tool descriptions, server instructions, overlay notes, error messages a model reads): states the
  current contract, leaves out implementation details, and corrects something models really get wrong.
- **Language**: comments, docs, tests and model-facing text are in English; Chinese is only for user input samples and
  eval tasks.
- **Commits**: titles follow Conventional Commits; the release script picks the version and the CHANGELOG from them, so
  the type should match the change (a user-visible change is not `chore`).
- **Gitea workflows**: `.gitea/workflows` use this Gitea's own actions (`builtin:checkout`, `self:actions/...`) and runner
  labels, not GitHub's. Events raised by the actions user (its pushes, tags and PRs) start no workflow.
- **Docs in step**: when behaviour, environment variables or workflows change, README.md, DEVELOPMENT.md and
  ARCHITECTURE.md change where they describe them.
- **Evals**: the referee goes straight to the open API, never through the MCP under test.

## Skip

- Formatting, lint and type errors: CI runs oxfmt, oxlint and tsc.
- `src/generated/`, `spec/`, `package-lock.json` and `CHANGELOG.md`: generated or copied, and left out of the diff.
- Wording preferences in comments and docs that change no behaviour.
- Problems the change neither introduces nor touches.
