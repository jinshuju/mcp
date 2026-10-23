# Development

How to build, run, deploy and evaluate `@jinshuju/mcp`. The README covers using it; [ARCHITECTURE.md](ARCHITECTURE.md) covers how it fits together.

## Commands

```bash
npm install
npm run generate     # spec/openapi.yaml + mcp.overlay.yaml -> src/generated/ (operations / tools / schemas / meta)
npm run check        # typecheck + oxlint + oxfmt
npm test             # builds, then runs node:test without touching the network
npm run dev          # local HTTP server: http://127.0.0.1:8787/mcp
npm run spec:update  # fetches the latest live openapi.yaml and regenerates
```

After changing `mcp.overlay.yaml` or updating `spec/openapi.yaml`, run `npm run generate` and commit `src/generated/`; CI checks it.

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

## Deployment

- **Docker (official)**:

  `docker build -t jinshuju-mcp . && docker run -p 8787:8787 -e JINSHUJU_MCP_PUBLIC_URL=https://mcp.jinshuju.net jinshuju-mcp`

- **Cloudflare Workers (optional)**:

  `npx wrangler login && npm run worker:deploy`

- **WDL or another Workers-compatible platform (optional)**:

  with [`@wdl-dev/cli`](https://github.com/wdl-dev/cli) installed and its token configured

  `npm run wdl:deploy`

  set the public URL as the secret `JINSHUJU_MCP_PUBLIC_URL` (`wdl secret put --worker jinshuju-mcp JINSHUJU_MCP_PUBLIC_URL`),with several entry points comma-separated, e.g. `https://mcp.jinshuju.net,https://<ns>.<platform>/jinshuju-mcp`

  to report to PostHog add the secret `POSTHOG_API_KEY`; to report to Sentry add `SENTRY_DSN`.

  `.gitea/workflows/deploy.yml` does the same from Gitea Actions: on its own when a release lands on `main`, and on demand (Actions → Deploy → Run workflow). It checks, tests and deploys; rerunning an older run rolls back to its commit.

The service is stateless and needs no database, KV or Durable Objects.

## Evals

`evals/` is an automated, multi-model evaluation built from real usage: 53 tasks (categories 找表单 / 读数据 / 统计汇总 / 建表单 / 改设置 / 批量写入 / 导入 — find forms, read entries, aggregate, create forms, change settings, batch writes, import)
run by several models against this repository's MCP, are scored by assertions, produce pass-rate and token tables by model × category,
and write every run into a Jinshuju form. Usage, task format and metrics are in [evals/README.md](evals/README.md).

```bash
npm run eval -- seed     # prepares fixture data in the eval account
npm run eval -- run      # all tasks × EVAL_MODELS → evals/results/<run_id>/report.md
```

## Code review

`.gitea/workflows/code-review.yml` has Claude review each pull request (`scripts/claude-review.sh`, guided by `.claude/agents/code-reviewer.md`): must-fix findings as inline comments, suggestions as PR comments, and an approval once none is left open.
The first review adds the `AI Reviewed` label, and later pushes are not reviewed again until someone adds `AI Re-review`; `skip-code-review` skips the review. A red run only means bot comments are still unresolved; it blocks no merge.
