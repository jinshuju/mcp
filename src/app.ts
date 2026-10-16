/**
 * HTTP entry (Hono): the same app runs on Node (node.ts) and Cloudflare Workers (worker.ts).
 *
 *   GET  /                                    landing page
 *   GET  /healthz                             health check
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728, pointing at account.jinshuju.net
 *   GET  /.well-known/oauth-authorization-server       RFC 8414 mirror (for older clients that probe only the resource domain)
 *   POST /mcp                                 MCP Streamable HTTP (2026-07-28 stateless; the 2025 handshake falls back to stateless)
 *
 * The service may sit under a path prefix (e.g. https://host/jinshuju-mcp/…, with the platform stripping the prefix when
 * forwarding): JINSHUJU_MCP_PUBLIC_URL gives the public address (prefix included; a comma-separated list gives several,
 * picked by the request's Host, so a custom domain and the platform's default address both work), and resource_metadata in
 * the 401 challenge points at the well-known document under this service's own path rather than the domain root; RFC 9728
 * lets clients fetch the URL the challenge gives. When it is not set, the address is inferred from the request (trusting
 * the reverse proxy's X-Forwarded-*).
 *
 * With POSTHOG_API_KEY set, every request's McpServer gets PostHog MCP analytics (analytics.ts), reported in waitUntil after
 * the response goes out. Unexpected exceptions go to Sentry (worker.ts initializes it with withSentry; without SENTRY_DSN the
 * SDK sends nothing; the Node entry is not wired): those a tool handler throws, an unreachable API during token verification,
 * and anything a route does not catch. A 4xx / 5xx from the API is a normal tool result and is not reported.
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
  /** For tests: skips fetching the real authorization server metadata */
  authServerMetadata?: OAuthMetadata;
  /** Analytics. Omitted, config decides (on only with posthogApiKey); null forces it off; node.ts / tests pass their own instance */
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

  // One McpServer per request, with the token closed over in every tool handler; analytics is installed per request too,
  // so the user and session follow the request. The analytics handle is stored per request object: the factory installs
  // it, and the route takes it out to flush after the response goes out.
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
  // Tools send no progress notifications, so the response is one JSON (the default auto mode): it is assembled after the handler finishes, and this request's analytics is complete before it returns.
  const handler: McpHttpHandler = createMcpHandler(factory, { legacy: 'reject' });

  /**
   * Stateless service for the 2025 handshake (initialize + Mcp-Session-Id). It is wired here instead of using the SDK's
   * own fallback only to answer with JSON instead of SSE: SSE sends the response headers before the handler runs, so the
   * Mcp-Session-Id the PostHog SDK mints on initialize (carrying the client name and version, and sent back by the client
   * on every later request) never reaches the headers, and tool call analytics would land after the response and before
   * the flush.
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
   * Public base URL (no trailing slash, may include a path prefix). With addresses configured, picks one by the request's
   * Host, falling back to the first; without, infers it from the request (trusting the reverse proxy's X-Forwarded-*).
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

  // Ignore trailing slashes: users often enter the address as /mcp/, which the default strict matching answers with 404.
  const app = new Hono({ strict: false });

  // Exceptions a route does not catch: Hono only logs them to console and answers 500 by default; also report them to Sentry here.
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

  // RFC 9728 protected resource metadata: the paths with and without /mcp answer the same document (for clients that probe only the origin).
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
  // RFC 8414 authorization server metadata mirror.
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
    // The API answered 401 during a tool call (the token expired mid-way): make the next request verify again.
    if (response.status === 401) await verifier.forget(token);
    const tracker = trackers.get(request);
    if (tracker) flushInBackground(c, tracker);
    return response;
  });

  return app;
}

/** An exception a tool throws: an unreachable API / timeout is environmental and logged as a warning; anything else is our bug. */
function reportToolError(error: unknown, tool: string): void {
  captureException(error, { tags: { tool }, level: error instanceof TransportError ? 'warning' : 'error' });
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** Sends this request's analytics: on Workers it goes into waitUntil and the response does not wait; Node has no executionCtx, so it fires and forgets. */
function flushInBackground(c: Context, tracker: RequestAnalytics): void {
  const flushing = tracker.flush().catch((error) => {
    console.error('posthog flush failed:', error);
    captureException(error, { level: 'warning' });
  });
  try {
    c.executionCtx.waitUntil(flushing);
  } catch {
    // Node: no executionCtx; sending already started above
  }
}
