# Architecture

`@jinshuju/mcp` 是怎么拼起来的，以及为什么这么拼。README 说它能做什么，这里说它怎么做，写给下一个改它的人。
技术选型的来龙去脉见 [docs/adr/0001-技术选型.md](docs/adr/0001-技术选型.md)。

## 原则

- **OpenAPI First。** `spec/openapi.yaml` 是唯一事实来源。工具的名字、参数、描述、返回结构都从它来；
  本仓库只决定「怎么投影」（`mcp.overlay.yaml`），不手写任何一个工具。
- **生成在构建期，不在运行期。** `npm run generate` 把 YAML 变成 `src/generated/*.json` 并提交进仓库。
  运行时不解析 YAML、不做 `$ref`；Workers 冷启动和 Node 进程一样快，PR 里能直接 review 工具 diff。
- **无状态。** 一个 HTTP 请求一个 `McpServer`，什么都不记。这是 MCP 2026-07-28 的模型，也是能随便横向扩容、
  不需要 Durable Objects / KV / session 粘滞的原因。2025 旧握手的客户端由 SDK 按无状态兜底。
- **只做 Resource Server。** 令牌由 account.jinshuju.net 签发、由 API v1 校验，本服务一个都不签。
- **服务端拥有词汇表。** 字段类型、场景、操作符都是 API 的；本服务校验形状（JSON Schema），把词原样递过去。

## 模块

```
spec/openapi.yaml        线上 https://jinshuju.net/api/v1/openapi.yaml 的副本（spec-sync workflow 每天更新）
mcp.overlay.yaml         投影规则：exclude / pointerSchemas / bodyParam / 每个工具的覆盖
scripts/generate.ts      YAML + overlay -> src/generated/{operations,tools,schemas,meta}.json（唯一知道 OpenAPI 的地方）
scripts/fetch-spec.mjs   拉线上 YAML

src/
  types.ts        生成产物的形状（OperationSpec / ToolSpec / BodySpec）
  api.ts          JinshujuApi：按 OperationSpec 发一次请求（URL、query、JSON / multipart、Bearer、超时、401 续期一次）
  result.ts       把 ApiResponse 翻译成 CallToolResult（截断、structuredContent、错误详情）
  tools.ts        把 ToolSpec 注册成 MCP 工具；get_schema
  composites.ts   组合工具的编排：考试 / 测评建改（两个请求）、count_entries 单 / 多表单分发
  server.ts       buildServer：McpServer + 工具 + resources + instructions
  credential.ts   凭证来源：Bearer 字符串；或 ~/.jinshuju/config.json（与 @jinshuju/cli 共用，含 refresh）
  auth.ts         HTTP 鉴权：Bearer 提取、按令牌哈希缓存的校验（GET /me）、401 challenge、AS 元数据
  app.ts          Hono 应用：/、/healthz、/.well-known/*、/mcp
  node.ts         Node 入口（官方部署：Docker）
  worker.ts       Cloudflare Workers 入口（可选）
  stdio.ts        本地 stdio 入口（npm bin: jinshuju-mcp）
  config.ts       环境变量 -> Config
  version.ts      版本号（release-please 同步）
  *.test.ts       node:test；不碰网络，fetch 全部注入
```

依赖方向：`app` / `stdio` → `server` → `tools` → `composites` → `result` → `api` → `credential`；`types`、`config`、`version` 不依赖任何人。

工具集与 builtin MCP 的 60 个工具一一对齐（overlay 的 `include` 就是对齐表）：54 个一对一映射到操作，
`edit_field_rules` 是 `updateForm` 请求体里 `field_rules` 的投影，考试 / 测评的 4 个建改工具和 `count_entries` 是组合工具。
`operations.json` 收录全部 113 个操作，组合工具据此调用没有单独暴露的操作（如 `updateExamSetting`）。

## 一次工具调用

1. 客户端 `POST /mcp`。`app.ts` 取出 Bearer；没有就回 `401` + `WWW-Authenticate: Bearer resource_metadata=…`，
   客户端据此去 `/.well-known/oauth-protected-resource/mcp` 发现 account.jinshuju.net 并走 OAuth。
2. `TokenVerifier` 按令牌的 SHA-256 查缓存；未命中就 `GET /me`。只有 `401` 才算无效（`403` 是 scope 不够，令牌本身有效）。
   结果缓存 5 分钟：每个工具调用不多花一次 API 配额。
3. `createMcpHandler` 用工厂为这个请求建一个 `McpServer`（`buildServer`），令牌闭包进每个工具的 handler。
4. SDK 按 `inputSchema` 校验参数（`fromJsonSchema`，Node 上 AJV，workerd 上 @cfworker/json-schema）。
   不合法直接回 `isError`，不发请求 —— 这是立项目标「参数有校验」在 MCP 这一侧的落地。
5. `JinshujuApi.call` 拼 URL：路径参数 `encodeURIComponent`，query 省略空值，数组 `name[]=`（Rails 读法）；
   请求体 = 入参去掉 path / query 参数后的其余键（flatten），或 `bodyParam` 那个键；JSON / multipart（base64 三元组还原成文件）。
   API 回 `401` 时让凭证续期一次再试（只对 stdio 的 OAuth 会话有意义）。组合工具由 `composites.ts` 决定先发哪个、
   失败时怎么说（建考试表单：表单先建、设置后写，设置被拒绝时明确说「表单已创建」；改考试表单：设置先发，被拒绝则其它改动一个不发）。
6. `toToolResult`：2xx → 紧凑 JSON 文本（超 `maxResultChars` 截断并提示用 fields / limit / next），
   有 `outputSchema` 的工具同时给 `structuredContent`；非 2xx → `isError`，文本里有 HTTP 状态、`error_description`、
   逐条 `errors[]`（pointer / message / code）和一句怎么办；`X-API-Input-Warnings` 任何时候都附在末尾。

`outputSchema` 只告诉模型会返回什么，不拒绝响应（绑定了一个永远通过的 validator）：
openapi.yaml 与线上实现偶有出入时，一次成功的 API 调用不应变成工具错误。

## 生成规则（scripts/generate.ts）

| 输入                                                                          | 产物                                                                                                                                                      |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operationId`（camelCase）                                                    | 工具名 snake_case；overlay 可改名                                                                                                                         |
| `summary` + `description`                                                     | `title` + `description`；「OAuth 令牌需要 scope」那行抽成 `_meta` 的 scopes                                                                               |
| path / query 参数                                                             | `inputSchema.properties` 顶层键；path 参数必填                                                                                                            |
| `requestBody`                                                                 | 缺省 flatten：请求体属性提升到入参顶层（与 builtin 习惯一致，运行时按参数名拆回）；数据本身（`entry`）和整个请求体是指针的操作嵌在一个键下（`bodyParam`） |
| `projections`                                                                 | 一个工具 = 某操作请求体的一个子键，子键属性提升到顶层，发出时包回 `{ 子键: … }`                                                                           |
| `composites`                                                                  | 入参由主操作 + 场景设置操作的 schema 拼成，编排在 `composites.ts`                                                                                         |
| `multipart/form-data` 的 `file`                                               | `file_base64` + `file_name` + `content_type`                                                                                                              |
| HTTP 方法                                                                     | annotations：GET 只读幂等；DELETE 破坏性幂等；PUT/PATCH 幂等；POST 其它                                                                                   |
| 2xx 响应 schema                                                               | 压缩后 ≤ `outputSchemaMaxChars` 才随 tools/list 下发，否则描述里留「返回结构见 schema「X」」                                                              |
| `pointerSchemas` 里的 `$ref`                                                  | 不内联，换成一句指向 `get_schema` / `jinshuju://schemas/{name}` 的说明                                                                                    |
| `omitSchemas` 里的 `$ref`                                                     | 整个去掉（只给服务端校验用的 if/then 组合约束，对模型没有信息量）                                                                                         |
| 内联的 `oneOf` / `anyOf`，分支都有 `title` 且 ≥ `collapseVariantsMinBranches` | 折叠：只留公共属性，分支名写进描述（表格列 11 种从 12k 字符降到几百）                                                                                     |
| 其余 `$ref`                                                                   | 内联（防环）；`discriminator` / `xml` / `nullable` 去掉，`example` 改 `examples`                                                                          |
| `components.schemas` 全部                                                     | `schemas.json` 目录，按 type 分支的带 `x-variants`（type → 分支 schema 名）                                                                               |

指针化是 token 瘦身的关键：`FieldInput` 一个 schema（52 种字段类型的联合）内联进 create_form / update_form 就是
两万多 token；换成一句话加一个 `get_schema` 工具后，模型只在真的要建表单时才读它需要的那一两个类型。

## 鉴权与部署

- **HTTP。** 任何能发 Bearer 的客户端都能用：OAuth（客户端自动走 account.jinshuju.net，支持动态注册 + PKCE + refresh）
  或直接贴个人 / 企业 Access Token。本服务不区分，都转给 API。
- **stdio。** `JINSHUJU_ACCESS_TOKEN` 优先，其次 `~/.jinshuju/config.json`（`jinshuju auth login` 写的）。
  OAuth 会话快过期或遇到 401 时用 refresh_token 续期并原子写回（mode 600）。cli 和 mcp 共用一次登录。
- **Node（官方）。** `Dockerfile` 一个进程，`PORT` 监听，`/healthz` 探活。无状态，随便扩副本。
  对外地址可配 `JINSHUJU_MCP_PUBLIC_URL`，否则信任反向代理的 `X-Forwarded-Proto/Host`。
- **Workers（可选）。** `wrangler.jsonc` 没有任何绑定；`worker.ts` 只是把 Hono app 导出。

## 测试

`npm test` 构建后跑 `node --test dist/*.test.js`。`fetch` 全部注入，不碰网络、不读用户的凭证文件：

- `generated.test.ts` 守生成产物的不变量：与 builtin 的 60 个工具一一对齐、无 `$ref`、路径参数必填、flatten / 嵌套、投影与组合的入参形状、指针化、注解；
- `api.test.ts` 守 URL / body / multipart / 401 续期 / 传输错误；
- `server.test.ts` 用 `InMemoryTransport` + `@modelcontextprotocol/client` 走完整的 tools/list、tools/call、组合工具的请求顺序与失败说明、resources；
- `app.test.ts` 用 Hono 的 `app.request` 走 401 challenge、PRM、缓存、旧协议握手。

## 发布与同步

- CI 检查 `npm run generate` 后 `src/generated` 没有 diff，保证产物不漂移。
- `spec-sync.yml` 每天拉线上 openapi.yaml，有变化就重新生成并开 PR —— 人只需要 review 工具的 diff。
- `release.yml` 与 jinshuju/cli 相同：release-please 维护版本 PR，合并即通过 OIDC 发布到 npm。
