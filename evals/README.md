# evals/ — MCP evals

Automated, multi-model evaluation and scoring built from real usage.
Fixed tasks are run by several models against this repository's MCP (connected in process by default, or a deployment over HTTP),
are scored by assertions, produce pass-rate and token tables by model × task category, and every run is written into a Jinshuju form.

```
evals/
  fixtures.yaml        Fixtures: the 5 forms and seed data the assertions rely on (versioned; anyone can re-seed)
  tasks/*.yaml         Sample set: 52 tasks in 7 categories; each task = a natural-language input + expected assertions
  src/
    cli.ts             Entry point: seed / run / report / upload / reset / sweep / tasks / catalog
    fixtures.ts        Creates forms, seeds data, resets, and archives forms created during evals
    tasks.ts           Loads and validates the sample set
    mcp.ts             Connects to the MCP under test (in-process buildServer or Streamable HTTP) with the same Jinshuju credential
    llm.ts             OpenAI-compatible chat/completions (retries, usage normalisation, MCP tools → function calling)
    agent.ts           Agent loop: system prompt + task → tool calls → final answer, recording tokens and the tool sequence per turn
    assertions.ts      Assertions: tool sequence / turns / answer substrings and regexes / LLM judge claims / real state after the run
    judge.ts           LLM-as-judge (the judge model is fixed and written into the results)
    runner.ts          Task × model × MCP matrix, with read / write locks per fixture; writes results/<run_id>/
    report.ts          Aggregates into report.md / summary.json
    upload.ts          Writes to the Jinshuju form 「MCP 评测结果（自动写入）」 ("MCP eval results (written automatically)")
  reports/             Archive of each round's report (copies of report.md with conclusions) — not committed
  state/               fixtures.json (fixture tokens, api_codes, seed serial numbers, results form token) — not committed
  results/<run_id>/    meta.json, runs.jsonl, transcripts/, report.md, summary.json — not committed
```

## Quick start

```bash
# 1. Credentials: Jinshuju uses JINSHUJU_ACCESS_TOKEN or `npx @jinshuju/cli auth login` (shares ~/.jinshuju/config.json with the MCP)
#    Models go through an OpenAI-compatible gateway, configured in evals/.env.local (not committed):
#    LLM_BASE_URL=https://<gateway>/v1
#    LLM_API_KEY=sk-...
#    EVAL_MODELS=anthropic-claude-sonnet-5-5,anthropic-claude-haiku-5-5,qwen3.7-plus,deepseek-v4.1-flash
#    EVAL_JUDGE_MODEL=anthropic-claude-sonnet-5-5

npm run eval -- seed            # creates the fixture forms in the eval account and seeds data (idempotent; --reset forces a re-seed)
npm run eval -- catalog         # shows the MCP's version, tool count and tools/list size
npm run eval -- run             # all tasks × EVAL_MODELS; then writes the report and fills the results form
npm run eval -- run --tasks read-01,agg-03 --models deepseek-v4.1-flash --mcp new --verbose --no-upload
npm run eval -- report <run_id> # regenerates report.md / summary.json
npm run eval -- upload <run_id> # writes the results into the Jinshuju form (idempotent)
```

Other `run` options: `--category 读数据,统计汇总`, `--sample 10` (deterministic sampling), `--repeat 3`, `--concurrency 5`,
`--judge <model>`, `--run-id <id>`, `--resume` (continue after an interruption), `--description-limit 1024` (truncates tool descriptions when the gateway limits their length),
`--mcp new,prod=https://jinshuju.net/mcp` (also runs against a deployment; `new` is this checkout, or `EVAL_NEW_MCP_URL` when set).

## Sample set

The tasks come from real tool-call records in production:
usage patterns were drawn from the tool sequences of sessions (e.g. `list_forms → get_form → count_entries`, the `get_form → edit_form` round trip,
`count_entries` failing on several forms with a keyword and switching to `search_entries_in_forms`, the date-format error of `list_form_entry_stats`),
then written up as tasks stratified into the 7 categories; each task's `source` field records the session pattern it came from.
`tasks/08-json-array-params.yaml` adds ten tasks rewritten from calls that failed validation in production because the model passed a real array
to `filters` / `sort` / `fields` / `metrics` / `dimensions` / `checks` / `form_tokens`; they keep those parameters exercised across categories.

Category names are the values used in `tasks/*.yaml` and `--category`:

| Category               | Tasks | Covers                                                                                                                  |
| ---------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| 找表单 (find forms)    | 7     | Find forms by topic, read structure and links, plan quotas, wrong tokens, recently active forms                         |
| 读数据 (read entries)  | 12    | Conditional filters, extremes, date ranges, cross-form search, submission counts, selected columns, sorting             |
| 统计汇总 (aggregate)   | 9     | Grouped counts / averages, conditional sums, shares, monthly buckets, date extremes                                     |
| 建表单 (create forms)  | 6     | Plain forms, unique constraints, exams, evaluations, copying, create form + settings                                    |
| 改设置 (edit settings) | 10    | Rename / description, add fields, add choices, hint text, password, required + unique, delete fields, theme, pre-checks |
| 批量写入 (batch write) | 5     | Add one entry, add in batch, batch update by condition, locate and edit, delete by condition                            |
| 导入 (import)          | 3     | CSV text, table text, back-filling with deduplication                                                                   |

Task format (`tasks/*.yaml`):

```yaml
- id: agg-03
  category: 统计汇总
  title: Conditional sum, split by a dimension
  source: production session pattern …
  prompt: 办公用品采购申请里，已批准的申请总金额是多少？再按部门分别算一下已批准的金额。
  fixtures: [orders] # fixtures it depends on; write tasks add writes: true, are reset before and after the run, and exclude other tasks
  max_turns: 8 # maximum model turns allowed
  expect:
    tools: # must call / any one of / must not call
      any_of: [aggregate_entries, list_entries]
      must_not_call: [create_entry]
    max_tool_calls: 10
    answer: # final answer
      contains: ['16140'] # every substring (ignoring case and full-width digits); supports {{alias.token}} / {{alias.url}} / {{account.plan}}
      contains_any: [...]
      regex: 'https?://…'
      claims: # facts the LLM judge checks one by one
        - 按部门的已批准金额为 研发部 6500、市场部 6400、销售部 840、人事部 2400
    state: # read back through the API after the run (the referee never goes through the MCP under test)
      - { check: entry_count, fixture: signup, filters: [{ field: name, operator: eq, value: 李雷 }], equals: 1 }
      - { check: entries_match, fixture: signup, filters: [...], all: { lunch: 需要 } }
      - {
          check: form_created,
          name: 信息安全意识测验,
          scene: exam,
          exam_setting: { limited_time: 15 },
          fields: [{ type: [single_choice], choices: 4 }]
        }
      - {
          check: form_field,
          fixture: training,
          label: 所属团队,
          type: [drop_down],
          choices_include: [平台组],
          after_label: 部门
        }
      - { check: form_props, fixture: training, setting: { success_message: 签到成功 } }
```

A task passes when all its assertions pass. `field` in assertions always uses the field key from the fixtures (`fields[].key` in `fixtures.yaml`), mapped to the api_code at run time.

## Fixtures and idempotence

- `seed` creates the folder 「MCP 评测数据（勿动）」 ("MCP eval data (do not touch)") in the eval account, creates the 5 forms from `fixtures.yaml` and seeds their data; running it again only fills the differences.
- Write tasks (`writes: true`) restore their fixture to the seed before and after running: delete extra entries, add missing ones, change edited values back, delete extra fields, restore settings and theme.
- After form-creating tasks (`creates_forms: true`), forms created during the run are moved into the folder 「MCP 评测产出（可删）」 ("MCP eval output (deletable)"), because the open API has no endpoint to delete a form.
- Write tasks on the same fixture run one at a time; read tasks run concurrently; different fixtures do not affect each other.
- Every result and assertion is read straight from the open API (`src/api.ts` reuses the main package's `JinshujuApi`), never through an MCP under test.

## Scoring and metrics

- **Main metric**: assertion pass rate, summarised by model × category.
- **Secondary metrics**: per task, input / output tokens, turns, tool calls, tool errors, retries after errors, truncated results, duration and run errors.
- Open-ended answers are checked claim by claim by an LLM judge; the judge model is fixed (`EVAL_JUDGE_MODEL`) and recorded in every result.
- Every model gets the same system prompt (with the server's `instructions` appended), the same tool-result truncation threshold (120k characters by default, the same as the server's own) and the same turn limit.
- `report.md` also gives the tools/list size, a fixed cost paid on every turn of a conversation.

## Persistence

After `run` (or with `upload <run_id>`), every run is written into the Jinshuju form 「MCP 评测结果（自动写入）」:
date, run ID, MCP, MCP version (`commit=… openapi=…` in process, serverInfo + tools/list hash over HTTP), model, task ID, task category, result,
assertion details, input / output tokens, turns, tool calls, tool errors, duration, tool sequence, final answer and judge model.
The form lives in the fixture folder, and its token is kept in `state/fixtures.json`; uploading the same run again writes nothing twice.

## CI

`.gitea/workflows/evals.yml`: on demand only (Actions → Evals → Run workflow; models, MCPs and tasks can be chosen).
It needs the secrets `EVAL_JINSHUJU_ACCESS_TOKEN` and `EVAL_LLM_API_KEY`, and the variables `EVAL_LLM_BASE_URL`, `EVAL_MODELS` and `EVAL_JUDGE_MODEL`.
The report ends the job log, and `evals/results/` is kept as an artifact for 90 days.

## Known limitations

- The open API has no endpoint to delete a form, so the output of form-creating tasks can only be archived into a folder and builds up in the account; use a dedicated eval account.
- Import tasks only check that the data lands correctly: a model may write with `create_entries` instead of uploading a file; the tool sequence shows which path was taken.
- When the plan does not support "show the score in exams" or "evaluation report", the server forces those settings to none, so no task asserts on them.
- Live sessions do not record the natural-language intent, so task wording is reconstructed from tool sequences, not the user's exact words.
