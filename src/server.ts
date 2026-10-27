/**
 * Assembles an McpServer. Stateless: one per HTTP request / per stdio connection, cheap and independent of each other.
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
  'To create a form: get_schema("FieldInput") maps each field type to its schema in x-variants (TextField → TextFieldInput, RadioButton → RadioButtonInput), get_schema on that name shows the type\'s properties, then call create_form.',
  'Wherever an input says `Shape: schema "X"`, look X up with get_schema; do not guess.',
  "An error gives the HTTP status and the server's error_description / errors; fix the call as they say and retry. On 429, wait as Retry-After says.",
  'A personal token sees only the forms its user created or that are shared with them; an account token sees every form in the account.'
].join('\n');

export interface BuildServerOptions {
  credential: Credential;
  config?: Partial<Config>;
  fetch?: typeof fetch;
  /** Server instructions, INSTRUCTIONS by default; with intent collection on in HTTP mode, the context argument's note is appended */
  instructions?: string;
  /** Callback when a tool throws (the HTTP deployment reports to Sentry); the error still goes to the model as usual */
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

  // The same schema catalog is also exposed as resources, for clients that prefer resources.
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
