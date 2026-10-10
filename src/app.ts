/**
 * HTTP 入口（Hono）：同一份 app 跑在 Node（node.ts）和 Cloudflare Workers（worker.ts）上。
 *
 *   GET  /                                    说明页
 *   GET  /healthz                             健康检查
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728，指向 account.jinshuju.net
 *   GET  /.well-known/oauth-authorization-server       RFC 8414 镜像（给只探测资源域名的旧客户端）
 *   POST /mcp                                 MCP Streamable HTTP（2026-07-28 无状态；2025 旧握手按无状态兜底）
 *
 * 服务可能挂在一个路径前缀下（如 https://host/jinshuju-mcp/…，平台转发时剥掉前缀）：
 * 对外地址用 JINSHUJU_MCP_PUBLIC_URL 指定（含前缀），401 质询里的 resource_metadata 指向本服务自己路径下的
 * well-known 文档，而不是域名根；RFC 9728 允许客户端直接按质询里给的 URL 取。
 */
import { Hono } from 'hono';
import {
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  type McpHttpHandler,
  type OAuthMetadata
} from '@modelcontextprotocol/server';
import { JinshujuApi } from './api.js';
import { TokenVerifier, bearerToken, challenge, loadAuthServerMetadata } from './auth.js';
import type { Config } from './config.js';
import { DEFAULTS } from './config.js';
import { StaticCredential } from './credential.js';
import { buildServer, META } from './server.js';
import { TOOLS } from './tools.js';
import { SERVER_TITLE, VERSION } from './version.js';

export interface AppOptions {
  config?: Partial<Config>;
  fetch?: typeof fetch;
  /** 测试用：跳过真实的授权服务器元数据拉取 */
  authServerMetadata?: OAuthMetadata;
}

export const MCP_PATH = '/mcp';

export function createApp(options: AppOptions = {}): Hono {
  const cfg: Config = { ...DEFAULTS, ...options.config };
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const api = new JinshujuApi({ baseUrl: cfg.apiBaseUrl, fetch: fetchImpl, timeoutMs: cfg.timeoutMs });
  const verifier = new TokenVerifier({ api, cacheTtlMs: cfg.tokenCacheTtlMs });
  let metadata: Promise<OAuthMetadata> | undefined;
  const authServerMetadata = () =>
    (metadata ??= options.authServerMetadata
      ? Promise.resolve(options.authServerMetadata)
      : loadAuthServerMetadata(cfg.authServer, fetchImpl));

  const handler: McpHttpHandler = createMcpHandler((ctx) => {
    const token = ctx.authInfo?.token;
    if (!token) throw new Error('unauthenticated request reached the MCP handler');
    return buildServer({ credential: new StaticCredential(token), config: cfg, fetch: fetchImpl });
  });

  /** 对外基址（无尾部斜杠，可含路径前缀）：配置优先，否则按请求推断（信任反向代理的 X-Forwarded-*）。 */
  function publicBase(request: Request): string {
    if (cfg.publicUrl) return cfg.publicUrl.replace(/\/$/, '');
    const url = new URL(request.url);
    const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host;
    const prefix = (request.headers.get('x-forwarded-prefix') ?? '').replace(/\/$/, '');
    return `${proto}://${host}${prefix}`;
  }
  const resourceUrl = (request: Request) => new URL(`${publicBase(request)}${MCP_PATH}`);
  const resourceMetadataUrl = (request: Request) =>
    `${publicBase(request)}/.well-known/oauth-protected-resource${MCP_PATH}`;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'mcp-protocol-version'
      }
    });

  const app = new Hono();

  app.get('/', (c) =>
    c.json({
      name: SERVER_TITLE,
      version: VERSION,
      mcp: resourceUrl(c.req.raw).href,
      docs: 'https://open.jinshuju.net/mcp',
      tools: TOOLS.length,
      generatedFrom: META.generatedFrom
    })
  );
  app.get('/healthz', (c) => c.text('ok'));

  // RFC 9728 保护资源元数据：带 /mcp 与不带的两个路径都应答同一份（兼容只探测 origin 的客户端）。
  const prmPaths = ['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${MCP_PATH}`];
  app.on(['GET', 'OPTIONS'], prmPaths, async (c) => {
    if (c.req.method === 'OPTIONS') return json(null, 204);
    const metadata = buildOAuthProtectedResourceMetadata({
      oauthMetadata: await authServerMetadata(),
      resourceServerUrl: resourceUrl(c.req.raw),
      resourceName: SERVER_TITLE,
      serviceDocumentationUrl: new URL('https://open.jinshuju.net/mcp'),
      scopesSupported: ['public', 'forms', 'read_entries', 'write_entries', 'form_setting', 'users']
    });
    return json(metadata);
  });
  // RFC 8414 授权服务器元数据镜像。
  app.on(['GET', 'OPTIONS'], '/.well-known/oauth-authorization-server', async (c) => {
    if (c.req.method === 'OPTIONS') return json(null, 204);
    return json(await authServerMetadata());
  });

  app.all(MCP_PATH, async (c) => {
    const request = c.req.raw;
    const prm = resourceMetadataUrl(request);
    const token = bearerToken(request);
    if (!token) return challenge(prm, 'Missing or invalid access token');
    let authInfo;
    try {
      authInfo = await verifier.verify(token);
    } catch (error) {
      console.error('token verification failed:', error);
      return new Response(
        JSON.stringify({ error: 'server_error', error_description: '无法校验令牌：金数据 API 暂时不可达' }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '5' }
        }
      );
    }
    if (!authInfo) return challenge(prm, 'Missing or invalid access token');
    const response = await handler.fetch(request, { authInfo });
    // 工具调用中 API 回了 401（令牌中途失效）：让下一次请求重新校验。
    if (response.status === 401) await verifier.forget(token);
    return response;
  });

  return app;
}
