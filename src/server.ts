/**
 * 组装一个 McpServer。无状态：每个 HTTP 请求 / 每个 stdio 连接各建一个，便宜且互不影响。
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { JinshujuApi } from './api.js';
import type { Config } from './config.js';
import { DEFAULTS } from './config.js';
import type { Credential } from './credential.js';
import { registerGeneratedTools, registerSchemaTools, SCHEMAS, type ToolRuntime } from './tools.js';
import type { GeneratedMeta } from './types.js';
import { SERVER_NAME, SERVER_TITLE, VERSION } from './version.js';
import metaJson from './generated/meta.json' with { type: 'json' };

export const META = metaJson as GeneratedMeta;

export const INSTRUCTIONS = [
  'MCP server for Jinshuju (金数据) forms, tables and entries. Each tool maps to the open API v1 and is generated from its openapi.yaml.',
  "Usual path: list_forms finds the form token → get_form shows the fields' api_code → list_entries / count_entries / aggregate_entries read entries;",
  'create_entry / patch_entries write them, keyed by api_code.',
  'To create a form: get_schema("FieldInput") lists the field types, get_schema("<Type>Input") shows a type\'s properties, then call create_form.',
  'Wherever an input says `Shape: schema "X"`, look X up with get_schema; do not guess.',
  "An error gives the HTTP status and the server's error_description / errors; fix the call as they say and retry. On 429, wait as Retry-After says.",
  'A personal token sees only the forms its user created or that are shared with them; an account token sees every form in the account.'
].join('\n');

export interface BuildServerOptions {
  credential: Credential;
  config?: Partial<Config>;
  fetch?: typeof fetch;
  /** 服务器说明，缺省 INSTRUCTIONS；HTTP 模式开了意图采集时在后面追加 context 参数的说明 */
  instructions?: string;
  /** 工具抛异常时的回调（HTTP 部署报 Sentry）；报错照常转给模型 */
  onToolError?: ToolRuntime['onError'];
}

export function buildServer({
  credential,
  config,
  fetch: fetchImpl,
  instructions,
  onToolError
}: BuildServerOptions): McpServer {
  const cfg: Config = { ...DEFAULTS, ...config };
  const api = new JinshujuApi({
    baseUrl: cfg.apiBaseUrl,
    fetch: fetchImpl,
    timeoutMs: cfg.timeoutMs,
    userAgent: `jinshuju-mcp/${VERSION}`
  });
  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: VERSION, websiteUrl: 'https://open.jinshuju.net/mcp' },
    { instructions: instructions ?? INSTRUCTIONS }
  );

  registerGeneratedTools(server, { api, credential, maxResultChars: cfg.maxResultChars, onError: onToolError });
  registerSchemaTools(server, META.pointerSchemas);

  // 同一份 schema 目录也作为资源暴露，给偏好 resources 的客户端用。
  server.registerResource(
    'schema',
    new ResourceTemplate('jinshuju://schemas/{name}', {
      list: () => ({
        resources: META.pointerSchemas.map((name) => ({
          uri: `jinshuju://schemas/${name}`,
          name,
          title: `schema ${name}`,
          mimeType: 'application/schema+json',
          description: (SCHEMAS[name]?.description as string | undefined)?.split('\n')[0]
        }))
      }),
      complete: {
        name: (value) =>
          Object.keys(SCHEMAS)
            .filter((n) => n.toLowerCase().startsWith(value.toLowerCase()))
            .slice(0, 20)
      }
    }),
    {
      title: 'API v1 schemas',
      description: 'JSON Schemas from components.schemas of openapi.yaml, read by name.',
      mimeType: 'application/schema+json'
    },
    async (uri, { name }) => {
      const schema = SCHEMAS[String(name)];
      if (!schema) throw new Error(`No schema named ${String(name)}`);
      return { contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: JSON.stringify(schema) }] };
    }
  );

  return server;
}
