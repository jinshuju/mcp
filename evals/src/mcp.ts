/**
 * 被测对象：按名字连上一个 MCP。
 * - new     ：本仓库的 MCP，缺省进程内直连 buildServer（评的就是当前 checkout）；设了 EVAL_NEW_MCP_URL 则走 HTTP。
 * - builtin ：金数据内置 MCP（https://jinshuju.net/mcp）。
 * - 任意 name=url：其它 HTTP 部署。
 * 两边都用同一份凭证（JINSHUJU_ACCESS_TOKEN 或 ~/.jinshuju/config.json），保证看到同一个账户的数据。
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
    throw new Error(`不认识的 MCP 目标：${s}（可用 new / builtin / name=url）`);
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

/** 调一次工具，把结果压成文本（isError 的也一样），超时按错误处理。 */
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
