# @jinshuju/mcp

The MCP server for Jinshuju ([jinshuju.net](https://jinshuju.net)): lets Claude, Cursor, Claude Code and other MCP-capable AI tools read and write forms, tables and entries.
The tools are generated from the [open API v1 openapi.yaml](https://jinshuju.net/api/v1/openapi.yaml) and stay in step with the API; the tool set matches the tools documented for the [Jinshuju MCP Server](https://open.jinshuju.net/mcp) one to one.

Two ways to use it:

- **Remote (HTTP)** — the official deployment, with OAuth sign-in; for claude.ai, Cursor, Windsurf and the like;
- **Local (stdio)** — `npx -y @jinshuju/mcp`; for local clients such as Claude Code, sharing one sign-in with [@jinshuju/cli](https://github.com/jinshuju/cli).

## Remote use

Server URL: `https://mcp.jinshuju.net/mcp` (until launch, the URL published at open.jinshuju.net/mcp is authoritative).

| Client      | Setup                                                                                   |
| ----------- | --------------------------------------------------------------------------------------- |
| claude.ai   | Settings → Connectors → Add custom connector, enter the server URL, sign in to Jinshuju |
| Claude Code | `claude mcp add jinshuju -s user --transport http https://mcp.jinshuju.net/mcp`         |
| Cursor      | `{ "mcpServers": { "jinshuju": { "url": "https://mcp.jinshuju.net/mcp" } } }`           |
| Windsurf    | Same as above, with the key `serverUrl`                                                 |

Without OAuth (CI, scripts), send an access token directly: `--header "Authorization: Bearer YOUR_ACCESS_TOKEN"`, or add `headers` to the config.
Create a personal access token under [Profile → API](https://next.jinshuju.net/profile/api), and an account access token under [System settings → Account API](https://next.jinshuju.net/system/api_licence).

## Local use (stdio)

```bash
# Sign in once (browser OAuth); the credential is stored in ~/.jinshuju/config.json and shared by the cli and mcp
npx -y @jinshuju/cli auth login

# Claude Code
claude mcp add jinshuju -s user -- npx -y @jinshuju/mcp
```

Or skip the sign-in and pass a token:

```bash
claude mcp add jinshuju -s user -e JINSHUJU_ACCESS_TOKEN=your_token -- npx -y @jinshuju/mcp
```

To check it works, ask the assistant to "list my Jinshuju forms".

## Tools

60 tools with the same names as those documented for the [Jinshuju MCP Server](https://open.jinshuju.net/mcp), plus `get_schema`. Each tool maps to one operation in openapi.yaml; a few combine two operations:

| Category            | Tools                                                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forms               | list_forms, get_form, create_form, edit_form, copy_form, move_form, list_form_cooperators, get_field_rules, edit_field_rules, check_field_data, preview_field_type_change, edit_theme                                               |
| Exams / evaluations | create_exam_form, edit_exam_form, create_evaluation_form, edit_evaluation_form (create / edit the form + its scene settings, two requests)                                                                                          |
| Entries             | list_entries, get_entry, create_entry, update_entry, delete_entry, create_entries, patch_entries, count_entries, aggregate_entries, get_form_data_summary, search_entries_in_forms, list_form_entry_stats, import_entries_from_file |
| What I submitted    | list_my_submitted_forms, list_my_submitted_entries, search_my_submitted_entries                                                                                                                                                     |
| Comments            | list_entry_comments, create_entry_comment, update_entry_comment, delete_entry_comment                                                                                                                                               |
| Views               | list_form_views, get_form_view, create_form_view, edit_form_view, delete_form_view, list_form_view_entries                                                                                                                          |
| Tables              | list_tables, get_table, create_table, edit_table, move_table                                                                                                                                                                        |
| Public queries      | list_opensearch_queries, get_opensearch_query, create_opensearch_query, edit_opensearch_query, get_opensearch_field_suggestions                                                                                                     |
| Folders / account   | list_folders, create_folder, get_current_user, get_current_billing_account, list_account_users                                                                                                                                      |
| Uploads             | upload_entry_attachment, upload_form_image, upload_import_file                                                                                                                                                                      |
| Schemas             | get_schema (reads an openapi schema by name, e.g. FieldInput, TextFieldInput)                                                                                                                                                       |

Differences from the tools documented at open.jinshuju.net/mcp:

- Presigned uploads (`prepare_*_upload`) are not in openapi.yaml; the `upload_*` tools here upload directly (the file is passed as base64);
- `update_entry` only updates partially (PATCH); there is no full replace;
- Data structures such as field types are served by the `get_schema` tool and the `jinshuju://schemas/{name}` resource.

The full tool → operation mapping is in `mcp.overlay.yaml` and `src/generated/meta.json`.

**Size.** The full tools/list is about 39k tokens (o200k estimate; about 36k without outputSchema).
It stays that size by not inlining large schemas: field definitions (52 types), form settings, themes and the like become a one-line pointer; unions that branch on type, such as table columns, keep only their common properties.
The model reads them on demand with `get_schema("FieldInput")` / `get_schema("TextFieldInput")`.

## Environment variables

| Variable                          | Meaning                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `JINSHUJU_ACCESS_TOKEN`           | Credential for stdio mode; when set, the config file is not read                                                                                       |
| `JINSHUJU_CONFIG`                 | Config file path, default `~/.jinshuju/config.json`                                                                                                    |
| `JINSHUJU_API_BASE_URL`           | API URL, default `https://jinshuju.net/api/v1`                                                                                                         |
| `JINSHUJU_AUTH_HOST`              | Authorization server, default `https://account.jinshuju.net`                                                                                           |
| `JINSHUJU_MCP_PUBLIC_URL`         | Public URL in HTTP mode (the resource in the OAuth metadata); a comma-separated list is chosen by the request's Host; empty infers it from the request |
| `JINSHUJU_MCP_MAX_RESULT_CHARS`   | Maximum characters of one result, default 120000; longer results are truncated with a hint to page                                                     |
| `JINSHUJU_MCP_TOKEN_CACHE_TTL_MS` | Token verification cache in HTTP mode, default 5 minutes                                                                                               |
| `POSTHOG_API_KEY`                 | PostHog project token (`phc_…`); when set, HTTP mode reports MCP analytics, see below                                                                  |
| `POSTHOG_HOST`                    | PostHog ingestion host, default `https://us.i.posthog.com`                                                                                             |
| `JINSHUJU_MCP_COLLECT_INTENT`     | Whether the model writes the user's intent in each call (`context` argument → `$mcp_intent`), default `true`                                           |
| `SENTRY_DSN`                      | Sentry project DSN; when set, the Workers entry reports exceptions, see below                                                                          |
| `SENTRY_ENVIRONMENT`              | Sentry environment name, optional                                                                                                                      |
| `PORT` / `HOST`                   | Where the Node entry listens, default 8787 / 0.0.0.0                                                                                                   |

## Usage analytics (PostHog MCP analytics)

With `POSTHOG_API_KEY` set, the HTTP deployment reports tool usage through [@posthog/mcp](https://posthog.com/docs/mcp-analytics), on the same terms as the built-in MCP at jinshuju.net/mcp:

- Only `$mcp_initialize` (legacy handshake) and `$mcp_tool_call` are reported; `tools/list`, resources, `$identify` and `$exception` are not;
- A tool call records the tool name, the argument names (`$mcp_input_keys`), the duration, whether it failed and the truncated error, **but not the argument values or the result**;
- Every tool gets one more argument, `context`, where the model writes what the user wants to do (`$mcp_intent`); email addresses, phone numbers, IPs and card numbers in it are masked before sending.
  With `JINSHUJU_MCP_COLLECT_INTENT=false` the argument is no longer advertised, and a client that still sends it gets no error;
- `distinct_id` is the Jinshuju user id; `$session_id` is derived from a hash of the token (one session per token); the client name / version come from the handshake or each request's `_meta`.

stdio (local) mode reports nothing.

## Error monitoring (Sentry)

The Workers entry (`src/worker.ts`) is wrapped with [@sentry/cloudflare](https://docs.sentry.io/platforms/javascript/guides/cloudflare/) and reports once `SENTRY_DSN` is set:

- It reports the unexpected: exceptions thrown by tool handlers (an unreachable API / timeout is a warning), the API being unreachable during token verification, and errors the routes did not catch. A 4xx / 5xx from the API is a normal tool result and is not reported;
- No request bodies, IPs or cookies are collected, and tracing is off; sensitive request headers such as `Authorization` are scrubbed to `[Filtered]` by the SDK; the user is recorded only as the Jinshuju user id.

The Node entry (Docker) and stdio report nothing.

## Development

```bash
npm install
npm run generate     # spec/openapi.yaml + mcp.overlay.yaml -> src/generated/ (operations / tools / schemas / meta)
npm run check        # typecheck + oxlint + oxfmt
npm test             # builds, then runs node:test without touching the network
npm run dev          # local HTTP server: http://127.0.0.1:8787/mcp
npm run spec:update  # fetches the latest live openapi.yaml and regenerates
```

After changing `mcp.overlay.yaml` or updating `spec/openapi.yaml`, run `npm run generate` and commit `src/generated/`; CI checks it.

## Deployment

- **Docker (official)**: `docker build -t jinshuju-mcp . && docker run -p 8787:8787 -e JINSHUJU_MCP_PUBLIC_URL=https://mcp.jinshuju.net jinshuju-mcp`
- **Cloudflare Workers (optional)**: `npx wrangler login && npm run worker:deploy`
- **WDL or another Workers-compatible platform (optional)**: with [`@wdl-dev/cli`](https://github.com/wdl-dev/cli) installed and its token configured, `npm run wdl:deploy`;
  set the public URL as the secret `JINSHUJU_MCP_PUBLIC_URL` (`wdl secret put --worker jinshuju-mcp JINSHUJU_MCP_PUBLIC_URL`),
  with several entry points comma-separated, e.g. `https://mcp.jinshuju.net,https://<ns>.<platform>/jinshuju-mcp`;
  to report to PostHog add the secret `POSTHOG_API_KEY` (and `POSTHOG_HOST` if needed); to report to Sentry add `SENTRY_DSN`.

The service is stateless and needs no database, KV or Durable Objects.

## Evals

`evals/` is an automated, multi-model evaluation built from real usage: 42 tasks (categories 找表单 / 读数据 / 统计汇总 / 建表单 / 改设置 / 批量写入 / 导入 — find forms, read entries, aggregate, create forms, change settings, batch writes, import)
run against both this repository's MCP and the built-in MCP (jinshuju.net/mcp), are scored by assertions, produce pass-rate and token tables by model × MCP × category,
and write every run into a Jinshuju form. Usage, task format and metrics are in [evals/README.md](evals/README.md).

```bash
npm run eval -- seed     # prepares fixture data in the eval account
npm run eval -- run      # all tasks × EVAL_MODELS × new,builtin → evals/results/<run_id>/report.md
```

## Design notes

- [ARCHITECTURE.md](ARCHITECTURE.md) — modules, the path of one call, generation rules, authentication
- [evals/README.md](evals/README.md) — the eval system: sample set, runner, scoring, persistence

## License

Apache-2.0
