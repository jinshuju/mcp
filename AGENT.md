# 给 AI 助手的项目约定

- `spec/openapi.yaml` 是唯一事实来源，`mcp.overlay.yaml` 只描述怎么把它投影成 MCP 工具。改完 overlay 跑 `npm run generate`，`src/generated/` 一并提交。
- `mcp.overlay.yaml` 越简洁越好。`descriptionAppend` 只写模型照着 openapi 描述仍会用错的地方（如多选字段按选项筛选用 `any_in` 而不是 `eq`）；API 放开某个限制后，直接删掉对应说明，不要改写成正面提示。
