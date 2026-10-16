# @jinshuju/mcp

The MCP server for Jinshuju ([jinshuju.net](https://jinshuju.net)): lets Claude, Cursor, Claude Code and other MCP-capable AI tools read and write forms, tables and entries.
The tools are generated from the [open API v1 openapi.yaml](https://jinshuju.net/api/v1/openapi.yaml) and stay in step with the API; the tool set matches the tools documented for the [Jinshuju MCP Server](https://open.jinshuju.net/mcp) one to one.

Two ways to use it:

- **Remote (HTTP)** — the official deployment at `https://jinshuju.net/mcp`, with OAuth sign-in; for claude.ai, Claude Code, Cursor, Windsurf and the like;
- **Local (stdio)** — `npx -y @jinshuju/mcp` with an access token; for clients that only run local servers.

## Remote use

Server URL: `https://jinshuju.net/mcp`

| Client      | Setup                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| claude.ai   | Settings → Connectors → Add custom connector, enter the server URL, sign in to Jinshuju                                                   |
| Claude Code | `claude mcp add jinshuju -s user --transport http https://jinshuju.net/mcp`, then run `/mcp` in Claude Code and sign in to Jinshuju there |
| Cursor      | `{ "mcpServers": { "jinshuju": { "url": "https://jinshuju.net/mcp" } } }`                                                                 |
| Windsurf    | Same as above, with the key `serverUrl`                                                                                                   |

Without OAuth (CI, scripts), send an access token directly: `--header "Authorization: Bearer YOUR_ACCESS_TOKEN"`, or add `headers` to the config.
Create a personal access token under [Profile → API](https://next.jinshuju.net/profile/api), and an account access token under [System settings → Account API](https://next.jinshuju.net/system/api_licence).

## Local use (stdio)

Pass an access token (created as above) in `JINSHUJU_ACCESS_TOKEN`:

```bash
# Claude Code
claude mcp add jinshuju -s user -e JINSHUJU_ACCESS_TOKEN=your_token -- npx -y @jinshuju/mcp
```

Other clients:

```json
{
  "mcpServers": {
    "jinshuju": {
      "command": "npx",
      "args": ["-y", "@jinshuju/mcp"],
      "env": { "JINSHUJU_ACCESS_TOKEN": "your_token" }
    }
  }
}
```

To check it works, ask the assistant to "list my Jinshuju forms".

## Tools

60 tools with the same names as those documented for the [Jinshuju MCP Server](https://open.jinshuju.net/mcp). Each tool maps to one operation in openapi.yaml; a few combine two operations:

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

The full tool → operation mapping is in `mcp.overlay.yaml` and `src/generated/meta.json`.

**Size.** The full tools/list is about 39k tokens (o200k estimate; about 36k without outputSchema).
It stays that size by not inlining large schemas: field definitions (52 types), form settings, themes and the like become a one-line pointer; unions that branch on type, such as table columns, keep only their common properties.
The model reads them on demand with `get_schema("FieldInput")` / `get_schema("TextFieldInput")`.

## Environment variables (stdio)

| Variable                        | Meaning                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `JINSHUJU_ACCESS_TOKEN`         | Access token (personal or account)                                                                 |
| `JINSHUJU_API_BASE_URL`         | API URL, default `https://jinshuju.net/api/v1`                                                     |
| `JINSHUJU_MCP_MAX_RESULT_CHARS` | Maximum characters of one result, default 120000; longer results are truncated with a hint to page |

## Development

Building, running and deploying the server: [DEVELOPMENT.md](DEVELOPMENT.md). How it fits together: [ARCHITECTURE.md](ARCHITECTURE.md).

## License

Apache-2.0
