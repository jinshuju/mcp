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

/** A Response that throws when its body is read: makes api.ts throw somewhere other than TransportError. */
function explodingResponse(message: string): Response {
  return { status: 200, headers: new Headers(), text: () => Promise.reject(new Error(message)) } as unknown as Response;
}

function text(result: { content?: unknown }): string {
  return (result.content as { text?: string }[]).map((c) => c.text ?? '').join('\n');
}

/** A fake Jinshuju API and a fake Sentry transport: calls the worker through withSentry as the platform does, and decodes events from the envelopes. */
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
      // By default the whole isolate shares the first client; the tests create one per request so each gets its own transport
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

test('API unreachable inside a tool: the model sees the error as usual; Sentry records a warning with the tool name and user id, without the token, IP or request body', async () => {
  const h = harness({
    forms: () => {
      throw new TypeError('connect ECONNREFUSED');
    }
  });
  const result = await h.callTool('list_forms', { limit: 1 });
  assert.equal(result.isError, true);
  assert.match(text(result), /Could not reach the Jinshuju API/);
  const events = h.events();
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.level, 'warning');
  assert.equal(event.tags?.tool, 'list_forms');
  assert.ok(event.exception?.values?.some((v) => v.type === 'TransportError'));
  assert.equal(event.user?.id, 'u1');
  assert.equal(event.user?.ip_address, undefined);
  assert.equal(event.sdk?.settings?.infer_ip, 'never', 'Sentry must not infer the IP from the connection either');
  assert.equal(event.request?.headers?.authorization, '[Filtered]');
  assert.equal(event.request?.data, undefined);
  assert.equal(event.release, 'jinshuju-mcp@0.1.0');
});

test('unexpected exception inside a tool: the model gets the error as before, and Sentry records an error', async () => {
  const h = harness({ forms: () => explodingResponse('boom') });
  const result = await h.callTool('list_forms', { limit: 1 });
  assert.equal(result.isError, true);
  assert.match(text(result), /boom/);
  const [event] = h.events();
  assert.equal(event?.level, 'error');
  assert.equal(event?.tags?.tool, 'list_forms');
  assert.ok(event?.exception?.values?.some((v) => v.value === 'boom'));
});

test('no SENTRY_DSN: nothing is sent and behavior is unchanged', async () => {
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

test('unexpected API failure during token verification: 503, and Sentry gets it', async () => {
  const h = harness({ me: () => explodingResponse('me exploded') });
  const res = await h.call('https://mcp.test/mcp', toolsList);
  assert.equal(res.status, 503);
  assert.ok(h.events().some((e) => e.exception?.values?.some((v) => v.value === 'me exploded')));
});

test('an exception the route does not catch: 500, and Sentry gets it', async () => {
  const h = harness();
  h.app.get('/boom', () => {
    throw new Error('boom route');
  });
  const res = await h.call('https://mcp.test/boom');
  assert.equal(res.status, 500);
  assert.ok(h.events().some((e) => e.exception?.values?.some((v) => v.value === 'boom route')));
});
