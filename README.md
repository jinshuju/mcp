# @jinshuju/mcp

金数据（[jinshuju.net](https://jinshuju.net)）的 MCP Server：让 Claude、Cursor、Claude Code 等支持 MCP 的 AI 工具读写表单、表格和数据。
工具按 [开放 API v1 的 openapi.yaml](https://jinshuju.net/api/v1/openapi.yaml) 自动生成，与 API 保持一致；工具集与 [金数据 MCP Server](https://open.jinshuju.net/mcp) 文档中的工具一一对应。

两种用法：

- **远程（HTTP）** — 官方部署，OAuth 登录，适合 claude.ai、Cursor、Windsurf 等；
- **本地（stdio）** — `npx -y @jinshuju/mcp`，适合 Claude Code 等本地客户端，和 [@jinshuju/cli](https://github.com/jinshuju/cli) 共用一次登录。

## 远程使用

服务地址：`https://mcp.jinshuju.net/mcp`（上线前以 open.jinshuju.net/mcp 公布的为准）。

| 客户端      | 配置                                                                            |
| ----------- | ------------------------------------------------------------------------------- |
| claude.ai   | Settings → Connectors → Add custom connector，填服务地址，按提示登录金数据      |
| Claude Code | `claude mcp add jinshuju -s user --transport http https://mcp.jinshuju.net/mcp` |
| Cursor      | `{ "mcpServers": { "jinshuju": { "url": "https://mcp.jinshuju.net/mcp" } } }`   |
| Windsurf    | 同上，键名用 `serverUrl`                                                        |

不想走 OAuth 的（CI、脚本）可以直接带 Access Token：`--header "Authorization: Bearer YOUR_ACCESS_TOKEN"` 或配置里加 `headers`。
个人 Access Token 在 [个人中心 → API](https://next.jinshuju.net/profile/api) 创建；企业 Access Token 在 [系统设置 → 企业 API](https://next.jinshuju.net/system/api_licence)。

## 本地使用（stdio）

```bash
# 先登录一次（浏览器 OAuth），凭证存在 ~/.jinshuju/config.json，cli 和 mcp 共用
npx -y @jinshuju/cli auth login

# Claude Code
claude mcp add jinshuju -s user -- npx -y @jinshuju/mcp
```

或者不登录，直接给 token：

```bash
claude mcp add jinshuju -s user -e JINSHUJU_ACCESS_TOKEN=your_token -- npx -y @jinshuju/mcp
```

验证：对助手说「列出我的金数据表单」。

## 有哪些工具

60 个工具，与 [金数据 MCP Server](https://open.jinshuju.net/mcp) 文档中的工具同名，外加一个 `get_schema`。每个工具对应 openapi.yaml 的一个操作，少数是两个操作的组合：

| 类别          | 工具                                                                                                                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 表单          | list_forms、get_form、create_form、edit_form、copy_form、move_form、list_form_cooperators、get_field_rules、edit_field_rules、check_field_data、preview_field_type_change、edit_theme                                               |
| 考试 / 测评   | create_exam_form、edit_exam_form、create_evaluation_form、edit_evaluation_form（建表单 / 改表单 + 场景设置，两个请求）                                                                                                              |
| 数据          | list_entries、get_entry、create_entry、update_entry、delete_entry、create_entries、patch_entries、count_entries、aggregate_entries、get_form_data_summary、search_entries_in_forms、list_form_entry_stats、import_entries_from_file |
| 我填写的      | list_my_submitted_forms、list_my_submitted_entries、search_my_submitted_entries                                                                                                                                                     |
| 评论          | list_entry_comments、create_entry_comment、update_entry_comment、delete_entry_comment                                                                                                                                               |
| 视图          | list_form_views、get_form_view、create_form_view、edit_form_view、delete_form_view、list_form_view_entries                                                                                                                          |
| 表格          | list_tables、get_table、create_table、edit_table、move_table                                                                                                                                                                        |
| 对外查询      | list_opensearch_queries、get_opensearch_query、create_opensearch_query、edit_opensearch_query、get_opensearch_field_suggestions                                                                                                     |
| 文件夹 / 账户 | list_folders、create_folder、get_current_user、get_current_billing_account、list_account_users                                                                                                                                      |
| 上传          | upload_entry_attachment、upload_form_image、upload_import_file                                                                                                                                                                      |
| 结构          | get_schema（按名字读 openapi 的 schema，如 FieldInput、TextFieldInput）                                                                                                                                                             |

与 open.jinshuju.net/mcp 文档中工具的差异：

- 预签名上传（`prepare_*_upload`）不在 openapi.yaml 里，这里提供的是直接上传（文件以 base64 传入）的 `upload_*`；
- `update_entry` 只做增量更新（PATCH），不提供整体覆盖；
- 字段类型等数据结构通过 `get_schema` 工具和 `jinshuju://schemas/{name}` 资源提供。

工具名 → 操作的完整映射见 `mcp.overlay.yaml` 和 `src/generated/meta.json`。

**体量。** 完整 tools/list 约 3.9 万 token（o200k 估算；不含 outputSchema 约 3.6 万）。
控制体量的办法是不内联大 schema：字段定义（52 种类型）、表单设置、主题等改成一句指针；表格列这类按 type 分支的联合只留公共属性。
模型需要时用 `get_schema("FieldInput")` / `get_schema("TextFieldInput")` 按需读取。

## 环境变量

| 变量                              | 说明                                                                   |
| --------------------------------- | ---------------------------------------------------------------------- |
| `JINSHUJU_ACCESS_TOKEN`           | stdio 模式的凭证；设了就不读配置文件                                   |
| `JINSHUJU_CONFIG`                 | 配置文件路径，缺省 `~/.jinshuju/config.json`                           |
| `JINSHUJU_API_BASE_URL`           | API 地址，缺省 `https://jinshuju.net/api/v1`                           |
| `JINSHUJU_AUTH_HOST`              | 授权服务器，缺省 `https://account.jinshuju.net`                        |
| `JINSHUJU_MCP_PUBLIC_URL`         | HTTP 模式对外地址（OAuth 元数据里的 resource）；留空按请求的 Host 推断 |
| `JINSHUJU_MCP_MAX_RESULT_CHARS`   | 单次结果最多字符数，缺省 120000，超过截断并提示分页                    |
| `JINSHUJU_MCP_TOKEN_CACHE_TTL_MS` | HTTP 模式令牌校验缓存，缺省 5 分钟                                     |
| `PORT` / `HOST`                   | Node 入口监听，缺省 8787 / 0.0.0.0                                     |

## 开发

```bash
npm install
npm run generate     # spec/openapi.yaml + mcp.overlay.yaml -> src/generated/（operations / tools / schemas / meta）
npm run check        # typecheck + oxlint + oxfmt
npm test             # 构建后跑 node:test，不碰网络
npm run dev          # 本地起 HTTP：http://127.0.0.1:8787/mcp
npm run spec:update  # 拉最新的线上 openapi.yaml 并重新生成
```

改 `mcp.overlay.yaml` 或更新 `spec/openapi.yaml` 后必须 `npm run generate` 并提交 `src/generated/`，CI 会检查。

## 部署

- **Docker（官方）**：`docker build -t jinshuju-mcp . && docker run -p 8787:8787 -e JINSHUJU_MCP_PUBLIC_URL=https://mcp.jinshuju.net jinshuju-mcp`
- **Cloudflare Workers（可选）**：`npx wrangler login && npm run worker:deploy`

服务无状态，不需要数据库、KV 或 Durable Objects。

## 设计说明

- [ARCHITECTURE.md](ARCHITECTURE.md) — 模块、一次调用的路径、生成规则、鉴权

## 许可证

Apache-2.0
