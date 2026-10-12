# evals/ — MCP 评测

基于真实用例、多模型的自动化测评与打分。
把同一批任务、同一批模型，分别接到 **新 MCP**（本仓库，进程内直连）和 **内置 MCP**（`https://jinshuju.net/mcp`）上跑，
按断言打分，输出「模型 × MCP × 任务类别」的通过率表与 token 表，并把每次运行写进一张金数据表单。

```
evals/
  fixtures.yaml        夹具：断言依赖的 5 个表单与种子数据（版本化，谁都能重灌）
  tasks/*.yaml         样本集 v1：42 个任务，7 个类别，每个任务 = 自然语言输入 + 期望断言
  src/
    cli.ts             入口：seed / run / report / upload / reset / sweep / tasks / catalog
    fixtures.ts        建表单、灌数据、重置、归档评测中新建的表单
    tasks.ts           加载与校验样本集
    mcp.ts             连接被测 MCP（进程内 buildServer 或 Streamable HTTP），同一份金数据凭证
    llm.ts             OpenAI 兼容 chat/completions（重试、用量归一化、MCP 工具 → function calling）
    agent.ts           agent loop：系统提示 + 任务 → 工具调用 → 最终答复，记录每轮 token 与工具序列
    assertions.ts      断言：工具序列 / 轮次 / 答复子串与正则 / LLM judge claims / 运行后的真实状态
    judge.ts           LLM-as-judge（judge 模型固定并写进结果）
    runner.ts          任务 × 模型 × MCP 矩阵，按夹具加读写锁，写 results/<run_id>/
    report.ts          聚合成 report.md / summary.json
    upload.ts          写入金数据表单「MCP 评测结果（自动写入）」
  reports/             每一轮对比报告的归档（带结论的 report.md 副本）— 不进仓库
  state/               fixtures.json（夹具 token、api_code、种子序号、结果表单 token）— 不进仓库
  results/<run_id>/    meta.json、runs.jsonl、transcripts/、report.md、summary.json — 不进仓库
```

## 快速开始

```bash
# 1. 凭证：金数据用 JINSHUJU_ACCESS_TOKEN 或 `npx @jinshuju/cli auth login`（与 MCP 共用 ~/.jinshuju/config.json）
#    模型走 OpenAI 兼容网关，写在 evals/.env.local（不进仓库）：
#    LLM_BASE_URL=https://<gateway>/v1
#    LLM_API_KEY=sk-...
#    EVAL_MODELS=anthropic-claude-sonnet-5,anthropic-claude-45-haiku,qwen3.8-max,deepseek-v4.1-flash
#    EVAL_JUDGE_MODEL=anthropic-claude-sonnet-5

npm run eval -- seed            # 在测评账户里建夹具表单并灌数据（幂等；--reset 强制重灌）
npm run eval -- catalog         # 看两个 MCP 的版本、工具数、tools/list 大小
npm run eval -- run             # 全部任务 × EVAL_MODELS × new,builtin；结束后生成报告并写入结果表单
npm run eval -- run --tasks read-01,agg-03 --models qwen3.8-max --mcp new --verbose --no-upload
npm run eval -- report <run_id> # 重新生成 report.md / summary.json
npm run eval -- upload <run_id> # 把结果写进金数据表单（幂等）
```

`run` 的其它参数：`--category 读数据,统计汇总`、`--sample 10`（确定性抽样）、`--repeat 3`、`--concurrency 5`、
`--judge <model>`、`--run-id <id>`、`--resume`（中断后续跑）、`--description-limit 1024`（网关对工具描述长度有限制时截断）。

## 样本集

任务来自内置 MCP 上线后的真实工具调用记录：
按会话里的工具序列归纳出使用模式（如 `list_forms → get_form → count_entries`、`get_form → edit_form` 的往返、
`count_entries` 多表单带关键字报错后改用 `search_entries_in_forms`、`list_form_entry_stats` 的日期格式报错），
再按卡片要求的 7 个类别分层写成任务；每个任务的 `source` 字段记录了对应的会话模式。

| 类别     | 任务数 | 说明                                                              |
| -------- | ------ | ----------------------------------------------------------------- |
| 找表单   | 6      | 按主题找表单、看结构与链接、套餐配额、错误 token、最近活跃        |
| 读数据   | 7      | 条件筛选、极值、日期范围、跨表单搜索、提交量统计                  |
| 统计汇总 | 7      | 分组计数 / 平均、条件求和、占比、按月分桶                         |
| 建表单   | 6      | 普通表单、唯一约束、考试、测评、复制、建表单 + 设置               |
| 改设置   | 8      | 改名 / 描述、加字段、加选项、提示语、密码、必填唯一、删字段、主题 |
| 批量写入 | 5      | 单条新增、批量新增、按条件批量更新、定位修改、按条件删除          |
| 导入     | 3      | CSV 文本、表格文本、带去重的补录                                  |

任务格式（`tasks/*.yaml`）：

```yaml
- id: agg-03
  category: 统计汇总
  title: 条件求和并按维度拆分
  source: 线上会话模式 …
  prompt: 办公用品采购申请里，已批准的申请总金额是多少？再按部门分别算一下已批准的金额。
  fixtures: [orders] # 依赖的夹具；写入类任务加 writes: true，会在运行前后重置并与其它任务互斥
  max_turns: 8 # 允许的最多模型轮次
  expect:
    tools: # 应调用 / 任选其一 / 不应调用
      any_of: [aggregate_entries, list_entries]
      must_not_call: [create_entry]
    max_tool_calls: 10
    answer: # 最终答复
      contains: ['16140'] # 全部子串（忽略大小写与全角数字）；支持 {{alias.token}} / {{alias.url}} / {{account.plan}}
      contains_any: [...]
      regex: 'https?://…'
      claims: # LLM judge 逐条核对的事实
        - 按部门的已批准金额为 研发部 6500、市场部 6400、销售部 840、人事部 2400
    state: # 运行后通过 API 读回来核对（裁判不经过被测 MCP）
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

一个任务通过 = 全部断言通过。断言里 `field` 一律用夹具里的字段 key（`fixtures.yaml` 的 `fields[].key`），运行时映射到 api_code。

## 夹具与幂等

- `seed` 在测评账户里建文件夹「MCP 评测数据（勿动）」，按 `fixtures.yaml` 建 5 个表单并灌数据；再次运行只补差异。
- 写入类任务（`writes: true`）运行前后都会把夹具恢复成种子：删多余数据、补缺失、改回被改动的值、删多出来的字段、恢复设置与主题。
- 建表单类任务（`creates_forms: true`）跑完后，运行期间新建的表单会移入「MCP 评测产出（可删）」文件夹（开放 API 没有删除表单的接口）。
- 同一个夹具上的写任务串行，读任务并发；不同夹具互不影响。
- 所有结果与断言都通过开放 API 直接读取（`src/api.ts` 复用主包的 `JinshujuApi`），不经过任何被测 MCP。

## 打分与指标

- **主指标**：断言通过率，按「模型 × MCP × 类别」汇总。
- **辅指标**：每个任务的输入 / 输出 token、轮次、工具调用数、工具报错数、报错后重试数、结果截断次数、耗时、运行错误数。
- 开放式答复用 LLM judge 逐条核对 claims，judge 模型固定（`EVAL_JUDGE_MODEL`）并记录在每条结果里。
- 两边一视同仁：同样的系统提示（附各自 `instructions`）、同样的工具结果截断阈值（缺省 120k 字符，与新 MCP 自身一致）、同样的轮次上限。
- `report.md` 还给出两边 tools/list 的大小，这是每轮对话都要付的固定成本。

## 持久化

`run` 结束后（或 `upload <run_id>`）把每条运行写进金数据表单「MCP 评测结果（自动写入）」：
日期、运行 ID、MCP、MCP 版本（新 MCP 为 `commit=… openapi=…`，内置为 serverInfo + tools/list 哈希）、模型、任务 ID、任务类别、结果、
断言明细、输入 / 输出 token、轮次、工具调用数、工具报错数、耗时、工具序列、最终答复、judge 模型。
表单在夹具文件夹里，token 记在 `state/fixtures.json`；同一运行重复上传不会重复写入。

## CI

`.github/workflows/evals.yml`：发版（release published）、`spec/openapi.yaml` / `mcp.overlay.yaml` / `evals/**` 变更、每周一，以及手动触发（可指定模型、MCP、任务）。
需要 secrets `EVAL_JINSHUJU_ACCESS_TOKEN`、`EVAL_LLM_API_KEY` 与 vars `EVAL_LLM_BASE_URL`、`EVAL_MODELS`、`EVAL_JUDGE_MODEL`。
报告写进 job summary，`evals/results/` 作为 artifact 保留 90 天。

## 已知限制

- 开放 API 没有删除表单的接口，建表单任务的产出只能归档到文件夹，账户里会累积；请用专用测评账户。
- 导入类任务只看数据是否正确落库：内置 MCP 的预签名上传需要客户端自己 PUT 文件，模型做不到，所以两边模型多半会改走 `create_entries`；走了哪条路在工具序列里。
- 套餐不支持「考试显示成绩」「测评报告」时服务端会把相应设置强制改为 none，任务没有对这两项做断言。
- 线上会话没有记录自然语言意图，任务的措辞是按工具序列还原的，不是逐字的用户原话。
