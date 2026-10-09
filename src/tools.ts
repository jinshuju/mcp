/**
 * 把生成的 ToolSpec 注册成 MCP 工具：一一对应的工具直接发请求，组合工具交给 composites.ts。
 */
import {
  fromJsonSchema,
  type McpServer,
  type jsonSchemaValidator,
  type JsonSchemaValidatorResult
} from '@modelcontextprotocol/server';
import type { JinshujuApi } from './api.js';
import { TransportError } from './api.js';
import { runComposite } from './composites.js';
import type { Credential } from './credential.js';
import { toToolResult } from './result.js';
import type { ToolSpec, JsonSchema } from './types.js';
import toolsJson from './generated/tools.json' with { type: 'json' };
import schemasJson from './generated/schemas.json' with { type: 'json' };

export { toToolResult } from './result.js';
export const TOOLS = toolsJson as ToolSpec[];
export const SCHEMAS = schemasJson as Record<string, JsonSchema>;

export interface ToolRuntime {
  api: JinshujuApi;
  credential: Credential;
  maxResultChars: number;
}

/**
 * outputSchema 只用来「告诉模型会返回什么」，不用来拒绝响应：
 * openapi.yaml 与线上实现偶有出入时，一次成功的 API 调用不应该因此变成工具错误。
 */
const permissiveValidator: jsonSchemaValidator = {
  getValidator:
    <T>() =>
    (input: unknown): JsonSchemaValidatorResult<T> => ({ valid: true, data: input as T, errorMessage: undefined })
};

export function registerGeneratedTools(server: McpServer, runtime: ToolRuntime): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema),
        outputSchema: tool.outputSchema ? fromJsonSchema(tool.outputSchema, permissiveValidator) : undefined,
        annotations: tool.annotations
      },
      async (args) => {
        try {
          if (tool.composite) return await runComposite(tool, args ?? {}, runtime);
          const res = await runtime.api.call(tool, args ?? {}, runtime.credential);
          return toToolResult(tool, res, runtime.maxResultChars);
        } catch (error) {
          if (error instanceof TransportError) {
            return { isError: true, content: [{ type: 'text', text: `${error.message}，请稍后重试。` }] };
          }
          throw error;
        }
      }
    );
  }
}

/** 列出可查的 schema 名，给 get_schema 的报错和 resources 列表用。 */
export function schemaNames(): string[] {
  return Object.keys(SCHEMAS);
}

export function registerSchemaTools(server: McpServer, pointerSchemas: string[]): void {
  server.registerTool(
    'get_schema',
    {
      title: '查看数据结构定义',
      description:
        '返回 openapi.yaml 里某个 schema 的完整 JSON Schema。工具入参 / 返回说明里写着「结构见 schema「X」」的地方，' +
        `用它查 X 的定义；按 type 分支的 schema（如 FieldInput）会带 x-variants，列出每个分支对应的 schema 名。常用：${pointerSchemas
          .slice(0, 6)
          .join('、')}。`,
      inputSchema: fromJsonSchema<{ name: string }>({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'schema 名，如 FieldInput、TextFieldInput、FormSettingWriteInput' }
        },
        required: ['name'],
        additionalProperties: false
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ name }) => {
      const schema = SCHEMAS[name];
      if (!schema) {
        const candidates = schemaNames()
          .filter((n) => n.toLowerCase().includes(name.toLowerCase()))
          .slice(0, 10);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `没有名为 ${name} 的 schema。${candidates.length ? `相近的有：${candidates.join('、')}` : ''}`
            }
          ]
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(schema) }] };
    }
  );
}
