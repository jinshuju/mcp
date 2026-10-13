import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createTransport, withSentry, type CloudflareOptions } from '@sentry/cloudflare';
import { createApp } from './app.js';
import { sentryOptions } from './worker.js';

const AS = {
  issuer: 'https://account.test',
  authorization_endpoint: 'https://account.test/oauth/authorize',
  token_endpoint: 'https://account.test/oauth/token',
  response_types_supported: ['code']
};

interface SentryEvent {
  release?: string;
  sdk?: { settings?: { infer_ip?: string } };
  level?: string;
  tags?: Record<string, string>;
  user?: { id?: string; ip_address?: string };
  request?: { headers?: Record<string, string>; data?: unknown };
  exception?: { values?: { type?: string; value?: string }[] };
}

const json = (body: string) => new Response(body, { headers: { 'Content-Type': 'application/json' } });

/** 读 body 时炸掉的 Response：让 api.ts 在 TransportError 之外的地方抛异常。 */
function explodingResponse(message: string): Response {
  return { status: 200, headers: new Headers(), text: () => Promise.reject(new Error(message)) } as unknown as Response;
}

function text(result: { content?: unknown }): string {
  return (result.content as { text?: string }[]).map((c) => c.text ?? '').join('\n');
}

/** 假的金数据 API + 假的 Sentry transport：像平台那样经 withSentry 调用 worker，事件从 envelope 里解出来。 */
function harness(options: { dsn?: boolean; me?: () => Response; forms?: () => Response } = {}) {
  const envelopes: string[] = [];
  const pending: Promise<unknown>[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/me')) return options.me?.() ?? json('{"id":"u1","name":"周"}');
    if (url.includes('/forms')) return options.forms?.() ?? json('{"total":0,"count":0,"data":[],"next":null}');
    return new Response('not found', { status: 404 });
  };
  const app = createApp({
    config: { apiBaseUrl: 'https://api.test/api/v1', publicUrls: ['https://mcp.test'] },
    fetch: fetchImpl,
    authServerMetadata: AS,
    analytics: null
  });
  const worker = withSentry(
    (): CloudflareOptions => ({
      ...sentryOptions(),
      dsn: options.dsn === false ? undefined : 'https://key@o1.ingest.sentry.io/1',
      // 缺省整个 isolate 共用第一个 client；测试里每个请求新建，transport 才是自己的
      cacheClient: false,
      transport: (transportOptions) =>
        createTransport(transportOptions, async (request) => {
          envelopes.push(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body));
          return { statusCode: 200 };
        })
    }),
    { fetch: (request: Request, env: unknown, ctx: unknown) => app.fetch(request, env as never, ctx as never) }
  );
  class Ctx {
    waitUntil(promise: Promise<unknown>): void {
      pending.push(promise);
    }
    passThroughOnException(): void {}
  }
  const settle = () => Promise.all(pending);
  const call = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const res = await worker.fetch(new Request(input instanceof Request ? input : String(input), init), {}, new Ctx());
    await settle();
    return res;
  };
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const transport = new StreamableHTTPClientTransport(new URL('https://mcp.test/mcp'), {
      fetch: call,
      requestInit: { headers: { Authorization: 'Bearer good' } }
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(transport);
    try {
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close();
      await settle();
    }
  };
  const events = (): SentryEvent[] =>
    envelopes
      .flatMap((body) =>
        body
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as SentryEvent)
      )
      .filter((item) => item.exception);
  return { app, call, callTool, events, envelopes };
}

const toolsList: RequestInit = {
  method: 'POST',
  headers: {
    Authorization: 'Bearer good',
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  },
  body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
};

test('工具里 API 连不上：模型照常看到报错；Sentry 记 warning，带工具名和用户 id，不带令牌、IP 和请求体', async () => {
  const h = harness({
    forms: () => {
      throw new TypeError('connect ECONNREFUSED');
    }
  });
  const result = await h.callTool('list_forms', { limit: 1 });
  assert.equal(result.isError, true);
  assert.match(text(result), /无法连接金数据 API/);
  const events = h.events();
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.level, 'warning');
  assert.equal(event.tags?.tool, 'list_forms');
  assert.ok(event.exception?.values?.some((v) => v.type === 'TransportError'));
  assert.equal(event.user?.id, 'u1');
  assert.equal(event.user?.ip_address, undefined);
  assert.equal(event.sdk?.settings?.infer_ip, 'never', 'Sentry 服务端也不要按连接推断 IP');
  assert.equal(event.request?.headers?.authorization, '[Filtered]');
  assert.equal(event.request?.data, undefined);
  assert.equal(event.release, 'jinshuju-mcp@0.1.0');
});

test('工具里的意外异常：转给模型的报错照旧，Sentry 记 error', async () => {
  const h = harness({ forms: () => explodingResponse('boom') });
  const result = await h.callTool('list_forms', { limit: 1 });
  assert.equal(result.isError, true);
  assert.match(text(result), /boom/);
  const [event] = h.events();
  assert.equal(event?.level, 'error');
  assert.equal(event?.tags?.tool, 'list_forms');
  assert.ok(event?.exception?.values?.some((v) => v.value === 'boom'));
});

test('没配 SENTRY_DSN：什么都不发，行为不变', async () => {
  const h = harness({
    dsn: false,
    forms: () => {
      throw new TypeError('connect ECONNREFUSED');
    }
  });
  const result = await h.callTool('list_forms', { limit: 1 });
  assert.equal(result.isError, true);
  assert.equal(h.envelopes.length, 0);
});

test('令牌校验时 API 出了意外：503，Sentry 收到', async () => {
  const h = harness({ me: () => explodingResponse('me exploded') });
  const res = await h.call('https://mcp.test/mcp', toolsList);
  assert.equal(res.status, 503);
  assert.ok(h.events().some((e) => e.exception?.values?.some((v) => v.value === 'me exploded')));
});

test('路由里没接住的异常：500，Sentry 收到', async () => {
  const h = harness();
  h.app.get('/boom', () => {
    throw new Error('boom route');
  });
  const res = await h.call('https://mcp.test/boom');
  assert.equal(res.status, 500);
  assert.ok(h.events().some((e) => e.exception?.values?.some((v) => v.value === 'boom route')));
});
