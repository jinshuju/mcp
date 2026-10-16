/**
 * The MCPs under test, connected by name:
 * - new:       this repo's MCP; by default buildServer in process (so it evaluates the current checkout), or over HTTP when EVAL_NEW_MCP_URL is set.
 * - builtin:   Jinshuju's built-in MCP (https://jinshuju.net/mcp).
 * - name=url:  any other HTTP deployment.
 * Every target uses the same credential (JINSHUJU_ACCESS_TOKEN or ~/.jinshuju/config.json), so they all see the same account's data.
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport, type Tool, type CallToolResult } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { buildServer, META } from '../../src/server.js';
import { configFromEnv } from '../../src/config.js';
import type { Credential } from '../../src/credential.js';
import { VERSION } from '../../src/version.js';
import type { EvalConfig } from './config.js';

export interface McpTarget {
  name: string;
  kind: 'inprocess' | 'http';
  url?: string;
}

export interface ConnectedMcp {
  target: McpTarget;
  client: Client;
  tools: Tool[];
  instructions?: string;
  version: string;
  catalog_chars: number;
  close(): Promise<void>;
}

export function parseTargets(specs: string[], cfg: EvalConfig): McpTarget[] {
  return specs.map((raw) => {
    const s = raw.trim();
    if (s === 'new') {
      return cfg.newMcpUrl ? { name: 'new', kind: 'http', url: cfg.newMcpUrl } : { name: 'new', kind: 'inprocess' };
    }
    if (s === 'builtin') return { name: 'builtin', kind: 'http', url: cfg.builtinMcpUrl };
    const eq = s.indexOf('=');
    if (eq > 0) return { name: s.slice(0, eq), kind: 'http', url: s.slice(eq + 1) };
    throw new Error(`Unknown MCP target: ${s} (use new / builtin / name=url)`);
  });
}

let gitShort: string | undefined;
function gitCommit(): string {
  if (gitShort === undefined) {
    try {
      gitShort = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      gitShort = 'unknown';
    }
  }
  return gitShort;
}

export async function connectMcp(target: McpTarget, credential: Credential, _cfg: EvalConfig): Promise<ConnectedMcp> {
  const client = new Client({ name: 'jinshuju-mcp-evals', version: VERSION });
  let close: () => Promise<void>;
  if (target.kind === 'inprocess') {
    const server = buildServer({ credential, config: configFromEnv() });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    close = async () => {
      await client.close();
      await server.close();
    };
  } else {
    const transport = new StreamableHTTPClientTransport(new URL(target.url!), {
      authProvider: {
        token: () => credential.token(),
        onUnauthorized: async () => {
          await credential.invalidate();
        }
      },
      requestInit: { headers: { 'User-Agent': `jinshuju-mcp-evals/${VERSION}` } }
    });
    await client.connect(transport);
    close = async () => {
      await client.close();
    };
  }
  const { tools } = await client.listTools();
  const catalog = JSON.stringify(tools);
  const hash = createHash('sha256').update(catalog).digest('hex').slice(0, 8);
  const info = client.getServerVersion();
  const version =
    target.kind === 'inprocess'
      ? `jinshuju-mcp@${VERSION} commit=${gitCommit()} openapi=${META.generatedFrom.sha256} tools=${hash}`
      : `${info?.name ?? 'mcp'}@${info?.version ?? '?'} tools=${hash}`;
  return {
    target,
    client,
    tools,
    instructions: client.getInstructions(),
    version,
    catalog_chars: catalog.length,
    close
  };
}

export interface ToolCallOutcome {
  text: string;
  is_error: boolean;
  duration_ms: number;
}

/**
 * Calls a tool once and flattens the result to text (isError results too); a timeout counts as an error.
 * The failure text goes to the model under test, so it stays in Chinese like the rest of the harness's prompts.
 */
export async function callTool(
  mcp: ConnectedMcp,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<ToolCallOutcome> {
  const started = Date.now();
  try {
    const result = (await mcp.client.callTool(
      { name, arguments: args },
      { timeout: timeoutMs, maxTotalTimeout: timeoutMs }
    )) as CallToolResult;
    const text = (result.content ?? [])
      .map((block) => {
        if (block.type === 'text') return block.text;
        if (block.type === 'resource' && 'text' in block.resource) return String(block.resource.text);
        return `[${block.type}]`;
      })
      .join('\n');
    const structured = result.structuredContent && !text ? JSON.stringify(result.structuredContent) : '';
    return { text: text || structured, is_error: !!result.isError, duration_ms: Date.now() - started };
  } catch (error) {
    return { text: `工具调用失败：${(error as Error).message}`, is_error: true, duration_ms: Date.now() - started };
  }
}
