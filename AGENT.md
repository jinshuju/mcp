# Conventions for AI assistants

- `spec/openapi.yaml` is the single source of truth; `mcp.overlay.yaml` only says how to project it into MCP tools. After changing the overlay, run `npm run generate` and commit `src/generated/` with it.
- Keep `mcp.overlay.yaml` as short as possible. `descriptionAppend` covers only what models still get wrong when following the openapi description (e.g. filtering a multiple-choice field by a choice uses `any_in`, not `eq`); when the API lifts a restriction, delete the matching note instead of rewording it as a positive hint. Use `description` to replace the original text entirely only when all of it is noise to the model (e.g. the HTTP authentication / multipart details of upload endpoints).
