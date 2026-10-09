/**
 * 组装一个 McpServer。无状态：每个 HTTP 请求 / 每个 stdio 连接各建一个，便宜且互不影响。
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { JinshujuApi } from './api.js';
import type { Config } from './config.js';
import { DEFAULTS } from './config.js';
import type { Credential } from './credential.js';
import { registerGeneratedTools, registerSchemaTools, SCHEMAS } from './tools.js';
import type { GeneratedMeta } from './types.js';
import { SERVER_NAME, SERVER_TITLE, VERSION } from './version.js';
import metaJson from './generated/meta.json' with { type: 'json' };

export const META = metaJson as GeneratedMeta;

export const INSTRUCTIONS = [
  '金数据（Jinshuju）表单 / 表格 / 数据的 MCP 服务，工具一一对应开放 API v1，按 openapi.yaml 生成。',
  '常见路径：list_forms 找到表单 token → get_form 看字段 api_code → list_entries / count_entries / aggregate_entries 读数据；',
  '写入用 create_entry / patch_entries_batch，字段键是 api_code。',
  '建表单：先 get_schema("FieldInput") 看字段类型，再 get_schema("<Type>Input") 看该类型属性，然后 create_form。',
  '入参里「结构见 schema「X」」的地方一律用 get_schema 查，不要猜。',
  '报错会给出 HTTP 状态和服务端的 error_description / errors，按提示修正后重试；429 按 Retry-After 等待。',
  '个人令牌只看得到自己创建或被共享的表单；企业令牌看得到企业全部表单。'
].join('\n');

export interface BuildServerOptions {
  credential: Credential;
  config?: Partial<Config>;
  fetch?: typeof fetch;
}

export function buildServer({ credential, config, fetch: fetchImpl }: BuildServerOptions): McpServer {
  const cfg: Config = { ...DEFAULTS, ...config };
  const api = new JinshujuApi({
    baseUrl: cfg.apiBaseUrl,
    fetch: fetchImpl,
    timeoutMs: cfg.timeoutMs,
    userAgent: `jinshuju-mcp/${VERSION}`
  });
  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: VERSION, websiteUrl: 'https://open.jinshuju.net/mcp' },
    { instructions: INSTRUCTIONS }
  );

  registerGeneratedTools(server, { api, credential, maxResultChars: cfg.maxResultChars });
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
      title: 'API v1 数据结构定义',
      description: 'openapi.yaml 中 components.schemas 的 JSON Schema，按名字读取。',
      mimeType: 'application/schema+json'
    },
    async (uri, { name }) => {
      const schema = SCHEMAS[String(name)];
      if (!schema) throw new Error(`没有名为 ${String(name)} 的 schema`);
      return { contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: JSON.stringify(schema) }] };
    }
  );

  return server;
}
