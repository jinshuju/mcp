/**
 * Registers the generated ToolSpecs as MCP tools: a one-to-one tool sends its request directly; a composite tool goes to composites.ts.
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
import { toolInputValidator } from './validation.js';
import toolsJson from './generated/tools.json' with { type: 'json' };
import schemasJson from './generated/schemas.json' with { type: 'json' };

export { toToolResult } from './result.js';
export const TOOLS = toolsJson as ToolSpec[];
export const SCHEMAS = schemasJson as Record<string, JsonSchema>;

export interface ToolRuntime {
  api: JinshujuApi;
  credential: Credential;
  maxResultChars: number;
  /** Told first when a tool throws (the HTTP deployment reports to Sentry); the error still goes to the model as usual; stdio passes none */
  onError?: (error: unknown, tool: string) => void;
}

/**
 * outputSchema only tells the model what comes back; it never rejects a response:
 * when openapi.yaml and the live implementation disagree now and then, a successful API call must not turn into a tool error.
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
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema, toolInputValidator),
        outputSchema: tool.outputSchema ? fromJsonSchema(tool.outputSchema, permissiveValidator) : undefined,
        annotations: tool.annotations
      },
      async (args) => {
        try {
          if (tool.composite) return await runComposite(tool, args ?? {}, runtime);
          const res = await runtime.api.call(tool, args ?? {}, runtime.credential);
          return toToolResult(tool, res, runtime.maxResultChars);
        } catch (error) {
          runtime.onError?.(error, tool.name);
          if (error instanceof TransportError) {
            return { isError: true, content: [{ type: 'text', text: `${error.message}. Retry later.` }] };
          }
          throw error;
        }
      }
    );
  }
}

/** Lists the schema names that can be looked up, for get_schema's error and the resources list. */
export function schemaNames(): string[] {
  return Object.keys(SCHEMAS);
}

export function registerSchemaTools(server: McpServer, pointerSchemas: string[]): void {
  server.registerTool(
    'get_schema',
    {
      title: 'Show a schema',
      description:
        'Returns the full JSON Schema of a schema in openapi.yaml. Where a tool input or result says `Shape: schema "X"` or ' +
        '`Returns schema "X"`, look X up here; a schema that branches on type (such as FieldInput) carries x-variants, ' +
        `which names the schema of each branch. Common ones: ${pointerSchemas.slice(0, 6).join(', ')}.`,
      inputSchema: fromJsonSchema<{ name: string }>(
        {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Schema name, e.g. FieldInput, TextFieldInput, FormSettingWriteInput' }
          },
          required: ['name'],
          additionalProperties: false
        },
        toolInputValidator
      ),
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
              text: `No schema named ${name}.${candidates.length ? ` Similar names: ${candidates.join(', ')}` : ''}`
            }
          ]
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(schema) }] };
    }
  );
}
