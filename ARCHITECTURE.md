# Architecture

How `@jinshuju/mcp` fits together, and why. The README says what it does and [DEVELOPMENT.md](DEVELOPMENT.md) how to build and run it; this says how it works, for the next person who changes it.

## Principles

- **OpenAPI first.** `spec/openapi.yaml` is the single source of truth. Tool names, arguments, descriptions and result shapes all come from it;
  this repository only decides how to project it (`mcp.overlay.yaml`) and hand-writes no tool.
- **Generated at build time, not at run time.** `npm run generate` turns the YAML into `src/generated/*.json`, which is committed.
  Nothing parses YAML or resolves `$ref` at run time; a Workers cold start is as fast as a Node process, and a PR shows the tool diff directly.
- **Stateless.** One `McpServer` per HTTP request, remembering nothing. This is the MCP 2026-07-28 model, and it is why the service scales out freely
  without Durable Objects / KV / sticky sessions. Clients on the 2025 legacy handshake are served statelessly by the SDK's fallback.
- **Resource Server only.** Tokens are issued by account.jinshuju.net and checked by API v1; this service issues none.
- **The server owns the vocabulary.** Field types, scenes and operators belong to the API; this service validates shapes (JSON Schema) and passes the words through unchanged.

## Modules

```
spec/openapi.yaml        Copy of the live https://jinshuju.net/api/v1/openapi.yaml (updated daily by the spec-sync workflow)
mcp.overlay.yaml         Projection rules: exclude / pointerSchemas / bodyParam / per-tool overrides
scripts/generate.ts      YAML + overlay -> src/generated/{operations,tools,schemas,meta}.json (the only place that knows OpenAPI)
scripts/fetch-spec.mjs   Fetches the live YAML
scripts/sync-summary.mjs Titles and describes the spec-sync PR from the src/generated diff

src/
  types.ts        Shapes of the generated output (OperationSpec / ToolSpec / BodySpec)
  api.ts          JinshujuApi: sends one request per OperationSpec (URL, query, JSON / multipart, Bearer, timeout, one refresh on 401)
  result.ts       Turns an ApiResponse into a CallToolResult (truncation, structuredContent, error details)
  tools.ts        Registers ToolSpecs as MCP tools; get_schema
  composites.ts   Orchestration of composite tools: create / edit exam and evaluation forms (two requests), count_entries for one / several forms
  server.ts       buildServer: McpServer + tools + resources + instructions
  credential.ts   Credential interface + Bearer string credential (no Node dependencies; the only one in the Worker bundle)
  cli-credential.ts  Local credential for stdio: ~/.jinshuju/config.json (shared with @jinshuju/cli, with refresh)
  auth.ts         HTTP authentication: Bearer extraction, verification cached by token hash (GET /me), 401 challenge, AS metadata
  analytics.ts    PostHog MCP analytics (@posthog/mcp): instruments the McpServer per request, decides what is and is not reported
  app.ts          Hono app: /, /healthz, /.well-known/*, /mcp
  node.ts         Node entry (official deployment: Docker)
  worker.ts       Cloudflare Workers entry (optional)
  stdio.ts        Local stdio entry (npm bin: jinshuju-mcp)
  config.ts       Environment variables -> Config
  version.ts      Version number (kept in sync by release-please)
  *.test.ts       node:test; no network, every fetch is injected
```

Dependency direction: `app` / `stdio` → `server` → `tools` → `composites` → `result` → `api` → `credential`; `types`, `config` and `version` depend on nothing.
`analytics` is used only by `app` / `node` (stdio does not report), and depends on `auth` (token hash), `tools` (the full set of argument names) and `validation` (the `context` argument name).

The tool set matches the 60 tools documented at open.jinshuju.net/mcp one to one (the overlay's `include` is the mapping): 54 map one to one onto operations,
`edit_field_rules` is a projection of `field_rules` in the `updateForm` request body, and the 4 exam / evaluation create and edit tools and `count_entries` are composite tools.
`operations.json` holds all 123 operations, so composite tools can call operations that are not exposed on their own (such as `updateExamSetting`).

## One tool call

1. The client sends `POST /mcp`. `app.ts` takes the Bearer token; without one it answers `401` + `WWW-Authenticate: Bearer resource_metadata=…`,
   from which the client finds account.jinshuju.net through `/.well-known/oauth-protected-resource/mcp` and runs OAuth.
2. `TokenVerifier` looks the token's SHA-256 up in its cache; on a miss it calls `GET /me`. Only `401` means invalid (`403` means insufficient scope; the token itself is valid).
   The result is cached for 5 minutes, so a tool call does not spend an extra API request.
3. `createMcpHandler` uses a factory to build an `McpServer` for this request (`buildServer`); the token is closed over in every tool handler.
   With `POSTHOG_API_KEY` set, the factory also runs `analytics.instrument(server, authInfo)`: the user id and the session id derived from the token are closed over in this one request.
   Requests on the 2025 legacy handshake (`isLegacyRequest`) do not take the SDK's own stateless fallback; they get their own `enableJsonResponse` transport:
   SSE sends the response headers before the handler runs, so the `Mcp-Session-Id` the PostHog SDK mints at `initialize` (carrying the client name and version, which the client
   replays on every later request) would never reach the response headers, and tool-call events would land after the response and before the flush.
4. The SDK validates arguments against `inputSchema` (`fromJsonSchema`: AJV on Node, @cfworker/json-schema on workerd).
   Invalid arguments return `isError` without sending a request: argument problems are stopped before they reach the API.
5. `JinshujuApi.call` builds the URL: path parameters are `encodeURIComponent`ed, empty query values are left out, arrays are sent as `name[]=` (how the server reads arrays),
   and a parameter declared with `content: application/json` (`filters` / `sort` / `metrics` / `dimensions` / `checks`) is sent as one value holding the JSON text, whether the model passed the array or the text;
   the request body = the arguments left after removing path / query parameters (flatten), or the `bodyParam` key; JSON / multipart (the base64 triple becomes a file again).
   When the API answers `401`, the credential refreshes once and retries (only meaningful for stdio OAuth sessions). For composite tools, `composites.ts` decides which request goes first
   and what to say on failure (creating an exam form: the form first, then the settings, and a rejected setting says plainly "The form was created"; editing an exam form: the settings first, and if they are rejected none of the other changes are sent).
6. `toToolResult`: 2xx → compact JSON text (truncated past `maxResultChars` with a hint to use fields / limit / next);
   tools with an `outputSchema` also get `structuredContent`; non-2xx → `isError`, with the HTTP status, `error_description`,
   each `errors[]` item (pointer / message / code) and one line on what to do; `X-API-Input-Warnings` is always appended at the end.

`outputSchema` only tells the model what comes back; it never rejects a response (it is bound to a validator that always passes):
when openapi.yaml and the live implementation disagree now and then, a successful API call should not turn into a tool error.

## Usage analytics (analytics.ts)

What is collected:

- Only `$mcp_initialize` and `$mcp_tool_call` are kept; every other event (`$mcp_tools_list`, `$mcp_resources_*`, `$identify`, `$exception`) is dropped in `beforeSend`;
  `$mcp_parameters` / `$mcp_response` / `$mcp_tool_description`, which the SDK adds by default, are removed too — only argument names are recorded (`$mcp_input_keys`), not values or results.
  The SDK cannot read the declarations in what `fromJsonSchema` produces, so the full set of argument names comes from `tools.json`; key names the model makes up are recorded as `[redacted]`.
- Failures: the SDK types only thrown exceptions, and our tools return `isError` results, so `beforeSend` buckets `$mcp_error_type` from the error text, whose shapes are all ours
  (`HTTP <status>:` from `result.ts`, the transport reasons from `api.ts`, the MCP SDK's `Input validation error:` prefix on a `validation.ts` failure):
  `validation` / `permission` (a 403 whose API error names the scope) / `rate_limited` (429) / `api_4xx` / `api_5xx` / `timeout` / `internal`, the buckets PostHog's own MCP dashboards use;
  an API failure also carries `$mcp_error_status`. `mcp_caller_type` is `jiri` for the Python MCP SDK defaults Jiri's remaining path runs on (client name `mcp`, `python-httpx` user agent), `external` otherwise.
- Intent: the SDK injects `context` into every tool's inputSchema, and `tools/call` strips it before validation and before the handler;
  `context` still arrives when collection is off or the client uses a cached tool list, so `validation.ts` always accepts and discards it, and it never reaches the API.
  The SDK's other injections (`llm_model`, `conversation_id`, `get_more_tools`, `send_feedback`) are all off.
- Identity and sessions: `identify` uses the user id from `GET /me`; `$session_id` is not the one the SDK opens per request but `ses_…` derived from the token's SHA-256
  (one session per token), so even clients on 2026-07-28 with no handshake have their calls grouped together.
  `initialize` is reported once a day per session (deduplicated in process; best effort across Workers instances).
- Sending: posthog-node batches. On Workers, `flush()` goes into `executionCtx.waitUntil` at the end of each request; on Node a timer does it, with `shutdown()` on SIGTERM.
  Tools send no mid-call notifications, and both legs assemble the response only after the handler finishes, so events are always queued before the flush.

## Generation rules (scripts/generate.ts)

| Input                                                                                        | Output                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operationId` (camelCase)                                                                    | Tool name in snake_case; the overlay can rename it                                                                                                                                                                                                                              |
| `summary` + `description`                                                                    | `title` + `description`; the `OAuth scope: …` line goes into `scopes` and is removed from the description                                                                                                                                                                       |
| path / query parameters                                                                      | Top-level keys of `inputSchema.properties`; path parameters are required                                                                                                                                                                                                        |
| query parameter with `content: application/json`                                             | The content schema itself (an array of typed items, e.g. `ScopeCondition`), `type: [array, string]` so the JSON text is accepted too, and the example as a real array; the openapi sentence telling HTTP callers to `JSON.stringify` it is dropped, since the runtime does that |
| query parameter whose schema is an array (`fields` / `form_tokens`)                          | `type: [array, string]`: the array is sent as `name[]=`, and the comma-separated string openapi.yaml also documents is passed through as is                                                                                                                                     |
| `requestBody`                                                                                | Flattened by default: body properties are lifted to the top level of the input (split back by name at run time); the entry data itself (`entry`) and bodies that are a pointer are nested under one key (`bodyParam`)                                                           |
| `projections`                                                                                | A tool = one sub-key of an operation's request body, with its properties lifted to the top level and wrapped back as `{ sub-key: … }` when sent                                                                                                                                 |
| `composites`                                                                                 | Input built from the schemas of the main operation + the scene settings operation; orchestrated in `composites.ts`                                                                                                                                                              |
| `file` in `multipart/form-data`                                                              | `file_base64` + `file_name` + `content_type`                                                                                                                                                                                                                                    |
| HTTP method                                                                                  | annotations: GET read-only and idempotent; DELETE destructive and idempotent; PUT/PATCH idempotent; POST none of these                                                                                                                                                          |
| 2xx response schema                                                                          | Ships with tools/list only when, minified, it is ≤ `outputSchemaMaxChars`; otherwise the description gets one line, `Returns schema "X"`                                                                                                                                        |
| `$ref` to a schema in `pointerSchemas`                                                       | Not inlined; replaced by one line pointing to `get_schema` / `jinshuju://schemas/{name}` (`Shape: schema "X"; …`)                                                                                                                                                               |
| `$ref` to a schema in `omitSchemas`                                                          | Removed entirely (if/then combined constraints used only for server-side validation tell the model nothing)                                                                                                                                                                     |
| Inlined `oneOf` / `anyOf` whose branches all have a `title`, ≥ `collapseVariantsMinBranches` | Collapsed: only the common properties stay, and the branch names go into the description (11 kinds of table column drop from 12k characters to a few hundred)                                                                                                                   |
| Any other `$ref`                                                                             | Inlined (cycle-safe); `discriminator` / `xml` / `nullable` removed, `example` becomes `examples`                                                                                                                                                                                |
| All of `components.schemas`                                                                  | The `schemas.json` catalog; schemas that branch on type carry `x-variants` (type → branch schema name)                                                                                                                                                                          |

Pointers are what keep the token count down: inlined into create_form / update_form, the one `FieldInput` schema (a union of 52 field types) costs
over twenty thousand tokens; as one line plus a `get_schema` tool, the model reads only the one or two types it needs, and only when it really creates a form.

## Authentication and deployment

- **HTTP.** Any client that can send a Bearer token works: OAuth (the client goes to account.jinshuju.net on its own, with dynamic registration + PKCE + refresh)
  or a personal / account access token pasted in. This service does not tell them apart; all go to the API.
- **stdio.** `JINSHUJU_ACCESS_TOKEN` first, then `~/.jinshuju/config.json` (written by `jinshuju auth login`).
  An OAuth session close to expiry, or one that meets a 401, is refreshed with its refresh_token and written back atomically (mode 600). The cli and mcp share one sign-in.
- **Node (official).** `Dockerfile` runs one process listening on `PORT`, with `/healthz` for health checks. Stateless; add replicas freely.
  The public URL can be set with `JINSHUJU_MCP_PUBLIC_URL` (it may carry a path prefix, e.g. `https://host/jinshuju-mcp`; a comma-separated list is chosen by the request's Host,
  falling back to the first), otherwise the reverse proxy's `X-Forwarded-Proto/Host/Prefix` are trusted. Under a prefix, `resource_metadata` in the 401 challenge points to the well-known document under this service's own path,
  not the domain root (the root does not belong to this service); RFC 9728 lets clients fetch the URL the challenge gives.
- **Workers (optional).** `wrangler.jsonc` has no bindings; `worker.ts` just exports the Hono app. Platforms like WDL forward in plain text after TLS termination,
  with `X-Forwarded-Proto` set to http and no `X-Forwarded-Prefix`, so inferring from the request gives the wrong URL. `JINSHUJU_MCP_PUBLIC_URL` is therefore required there,
  listing both the custom domain and the platform's default prefixed URL; the service picks one by Host.

## Tests

`npm test` builds, then runs `node --test dist/*.test.js`. Every `fetch` is injected; tests touch no network and do not read the user's credential file:

- `generated.test.ts` guards invariants of the generated output: one-to-one with the 60 documented tools, no `$ref`, required path parameters, flatten / nesting, input shapes of projections and composites, pointers, annotations;
- `api.test.ts` guards URL (including JSON-text query parameters) / body / multipart / refresh on 401 / transport errors;
- `server.test.ts` runs the full tools/list, tools/call, composite request order and failure messages, and resources through `InMemoryTransport` + `@modelcontextprotocol/client`;
- `app.test.ts` runs the 401 challenge, PRM, caching and the legacy handshake through Hono's `app.request`;
- `analytics.test.ts` injects a fake PostHog ingest and guards what is collected: which events, argument names without values, `context` never reaching the API, one session across both protocol versions, the error buckets and caller type, and behaviour when turned off or not configured.

## Evals (evals/)

`evals/` is not published; it is a regression test for how well models get on with the tools: fixed tasks run by several models against this repository's MCP (in-process `buildServer`, or a deployment over Streamable HTTP),
scored by assertions. The referee (fixture setup, state checks, writing results) goes straight to the open API (reusing `src/api.ts` and the operation table),
never through an MCP under test. Design, task format and metrics are in [evals/README.md](evals/README.md); `evals.yml` runs on release, on openapi.yaml changes and every Monday.

## Release and sync

- CI checks that `npm run generate` leaves no diff in `src/generated`, so the output never drifts.
- `spec-sync.yml` fetches the live openapi.yaml daily and, when it changed, regenerates and opens a PR — a person only reviews the tool diff. `scripts/sync-summary.mjs` titles it from that diff (added / removed tools, new fields, updated tools), since the squash-merged title is the CHANGELOG line.
- `release.yml` matches jinshuju/cli: release-please keeps a release PR, and merging it publishes to npm through OIDC.
