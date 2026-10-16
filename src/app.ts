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
 * 对外地址用 JINSHUJU_MCP_PUBLIC_URL 指定（含前缀；逗号分隔可给多个，按请求 Host 选用，自定义域名和平台默认地址
 * 都能用），401 质询里的 resource_metadata 指向本服务自己路径下的 well-known 文档，而不是域名根；RFC 9728 允许
 * 客户端直接按质询里给的 URL 取。不指定时按请求推断（信任反向代理的 X-Forwarded-*）。
 *
 * 配了 POSTHOG_API_KEY 时每个请求的 McpServer 都装上 PostHog MCP analytics（analytics.ts），响应发出后在 waitUntil 里上报。
 * 意外的异常报 Sentry（worker.ts 用 withSentry 初始化；没配 SENTRY_DSN 时 SDK 什么都不发，Node 入口没接）：
 * 工具 handler 抛出的、令牌校验时 API 不可达的、路由里没接住的。API 回的 4xx / 5xx 是正常的工具结果，不报。
 */
import { Hono, type Context } from 'hono';
import {
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type McpHttpHandler,
  type McpRequestContext,
  type OAuthMetadata
} from '@modelcontextprotocol/server';
import { captureException, setUser } from '@sentry/cloudflare';
import { analyticsFromConfig, CONTEXT_INSTRUCTIONS, type McpAnalytics, type RequestAnalytics } from './analytics.js';
import { JinshujuApi, TransportError } from './api.js';
import { TokenVerifier, bearerToken, challenge, loadAuthServerMetadata, userIdOf } from './auth.js';
import type { Config } from './config.js';
import { DEFAULTS } from './config.js';
import { StaticCredential } from './credential.js';
import { buildServer, INSTRUCTIONS, META } from './server.js';
import { TOOLS } from './tools.js';
import { SERVER_TITLE, VERSION } from './version.js';

export interface AppOptions {
  config?: Partial<Config>;
  fetch?: typeof fetch;
  /** 测试用：跳过真实的授权服务器元数据拉取 */
  authServerMetadata?: OAuthMetadata;
  /** 埋点。不传则按 config 决定（有 posthogApiKey 才开）；传 null 强制关；node.ts / 测试传自己的实例 */
  analytics?: McpAnalytics | null;
}

export const MCP_PATH = '/mcp';

export function createApp(options: AppOptions = {}): Hono {
  const cfg: Config = { ...DEFAULTS, ...options.config };
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const api = new JinshujuApi({ baseUrl: cfg.apiBaseUrl, fetch: fetchImpl, timeoutMs: cfg.timeoutMs });
  const verifier = new TokenVerifier({ api, cacheTtlMs: cfg.tokenCacheTtlMs });
  const analytics =
    options.analytics === undefined ? analyticsFromConfig(cfg, fetchImpl) : (options.analytics ?? undefined);
  const instructions = analytics?.collectIntent ? `${INSTRUCTIONS}\n${CONTEXT_INSTRUCTIONS}` : INSTRUCTIONS;
  let metadata: Promise<OAuthMetadata> | undefined;
  const authServerMetadata = () =>
    (metadata ??= options.authServerMetadata
      ? Promise.resolve(options.authServerMetadata)
      : loadAuthServerMetadata(cfg.authServer, fetchImpl));

  // 一个请求一个 McpServer，令牌闭包进每个工具的 handler；埋点也按请求装，用户与会话跟着请求走。
  // 埋点句柄按请求对象存着：factory 里装上，路由在响应发出后拿出来 flush。
  const trackers = new WeakMap<Request, RequestAnalytics>();
  const factory = async (ctx: McpRequestContext) => {
    const token = ctx.authInfo?.token;
    if (!token) throw new Error('unauthenticated request reached the MCP handler');
    const server = buildServer({
      credential: new StaticCredential(token),
      config: cfg,
      fetch: fetchImpl,
      instructions,
      onToolError: reportToolError
    });
    if (analytics && ctx.requestInfo) trackers.set(ctx.requestInfo, await analytics.instrument(server, ctx.authInfo));
    return server;
  };
  // 工具不发中途通知，响应就是一个 JSON（缺省的 auto 模式）：在 handler 跑完后才组装，本次请求的埋点在返回前已收齐。
  const handler: McpHttpHandler = createMcpHandler(factory, { legacy: 'reject' });

  /**
   * 2025 旧握手（initialize + Mcp-Session-Id）的无状态服务。不用 SDK 自带的兜底而自己接一遍，只为用 JSON 响应
   * 代替 SSE：SSE 在 handler 跑之前就把响应头发出去了，PostHog SDK 在 initialize 时铸的 Mcp-Session-Id（带客户端
   * 名字和版本，客户端之后每个请求都会带回来）落不到响应头上，工具调用的埋点也会落在响应之后、flush 之前。
   */
  async function serveLegacy(request: Request, authInfo: AuthInfo): Promise<Response> {
    if (request.method.toUpperCase() !== 'POST') return jsonRpcError(405, -32000, 'Method not allowed.');
    const server = await factory({ era: 'legacy', authInfo, requestInfo: request });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request, { authInfo });
    } catch (error) {
      console.error('legacy MCP request failed:', error);
      captureException(error);
      return jsonRpcError(500, -32603, 'Internal server error.');
    } finally {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    }
  }

  /**
   * 对外基址（无尾部斜杠，可含路径前缀）。配了地址就按请求的 Host 选一个，没有匹配的用第一个；
   * 没配则按请求推断（信任反向代理的 X-Forwarded-*）。
   */
  const publicUrls = cfg.publicUrls.map((u) => ({ base: u.replace(/\/$/, ''), host: new URL(u).host.toLowerCase() }));
  function publicBase(request: Request): string {
    const url = new URL(request.url);
    const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host)
      .split(',')[0]
      .trim();
    if (publicUrls.length) {
      const wanted = host.toLowerCase();
      return (publicUrls.find((u) => u.host === wanted) ?? publicUrls[0]).base;
    }
    const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
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

  // 不区分尾部斜杠：用户常把地址填成 /mcp/，缺省的严格匹配会让它 404。
  const app = new Hono({ strict: false });

  // 路由里没接住的异常：Hono 缺省只打 console 并回 500，这里顺带报 Sentry。
  app.onError((error, c) => {
    console.error('unhandled error:', error);
    captureException(error);
    return c.text('Internal Server Error', 500);
  });

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
      captureException(error);
      return new Response(
        JSON.stringify({
          error: 'server_error',
          error_description: 'Cannot verify the token: the Jinshuju API is unreachable for now'
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '5' }
        }
      );
    }
    if (!authInfo) return challenge(prm, 'Missing or invalid access token');
    const userId = userIdOf(authInfo);
    if (userId) setUser({ id: userId });
    const response = (await isLegacyRequest(request))
      ? await serveLegacy(request, authInfo)
      : await handler.fetch(request, { authInfo });
    // 工具调用中 API 回了 401（令牌中途失效）：让下一次请求重新校验。
    if (response.status === 401) await verifier.forget(token);
    const tracker = trackers.get(request);
    if (tracker) flushInBackground(c, tracker);
    return response;
  });

  return app;
}

/** 工具抛出的异常：API 连不上 / 超时是环境问题，记 warning；其它都是我们的 bug。 */
function reportToolError(error: unknown, tool: string): void {
  captureException(error, { tags: { tool }, level: error instanceof TransportError ? 'warning' : 'error' });
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** 把本次请求的上报发出去：Workers 上放进 waitUntil，响应不等它；Node 没有 executionCtx，发了就不管。 */
function flushInBackground(c: Context, tracker: RequestAnalytics): void {
  const flushing = tracker.flush().catch((error) => {
    console.error('posthog flush failed:', error);
    captureException(error, { level: 'warning' });
  });
  try {
    c.executionCtx.waitUntil(flushing);
  } catch {
    // Node：没有 executionCtx，上面已经在发了
  }
}
