/**
 * HTTP 入口（Hono）：同一份 app 跑在 Node（node.ts）和 Cloudflare Workers（worker.ts）上。
 *
 *   GET  /                                    说明页
 *   GET  /healthz                             健康检查
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728，指向 account.jinshuju.net
 *   GET  /.well-known/oauth-authorization-server       RFC 8414 镜像（给只探测资源域名的旧客户端）
 *   POST /mcp                                 MCP Streamable HTTP（2026-07-28 无状态；2025 旧握手按无状态兜底）
 */
import { Hono } from 'hono';
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
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
  const fetchImpl = options.fetch ?? fetch;
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

  /** 对外地址：配置优先，否则按请求推断（信任反向代理的 X-Forwarded-*）。 */
  function publicOrigin(request: Request): string {
    if (cfg.publicUrl) return cfg.publicUrl;
    const url = new URL(request.url);
    const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host;
    return `${proto}://${host}`;
  }
  const resourceUrl = (request: Request) => new URL(MCP_PATH, `${publicOrigin(request)}/`);

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

  app.all('/.well-known/*', async (c) => {
    const request = c.req.raw;
    const url = new URL(request.url);
    // 根路径的 PRM 也应答（等价于带 /mcp 的那份），兼容只探测 origin 的客户端。
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      url.pathname = `/.well-known/oauth-protected-resource${MCP_PATH}`;
    }
    const res = oauthMetadataResponse(new Request(url, request), {
      oauthMetadata: await authServerMetadata(),
      resourceServerUrl: resourceUrl(request),
      resourceName: SERVER_TITLE,
      serviceDocumentationUrl: new URL('https://open.jinshuju.net/mcp'),
      scopesSupported: ['public', 'forms', 'read_entries', 'write_entries', 'form_setting', 'users']
    });
    return res ?? c.notFound();
  });

  app.all(MCP_PATH, async (c) => {
    const request = c.req.raw;
    const prm = getOAuthProtectedResourceMetadataUrl(resourceUrl(request));
    const token = bearerToken(request);
    if (!token) return challenge(prm, 'Missing or invalid access token');
    const authInfo = await verifier.verify(token);
    if (!authInfo) return challenge(prm, 'Missing or invalid access token');
    const response = await handler.fetch(request, { authInfo });
    // 工具调用中 API 回了 401（令牌中途失效）：让下一次请求重新校验。
    if (response.status === 401) await verifier.forget(token);
    return response;
  });

  return app;
}
