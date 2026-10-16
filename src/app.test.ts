import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from './app.js';

const AS = {
  issuer: 'https://account.test',
  authorization_endpoint: 'https://account.test/oauth/authorize',
  token_endpoint: 'https://account.test/oauth/token',
  response_types_supported: ['code']
};

function app(meCalls: { count: number }, token = 'good') {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization');
    if (url.endsWith('/me')) {
      meCalls.count++;
      return auth === `Bearer ${token}`
        ? new Response('{"id":"u1","name":"周"}', { headers: { 'Content-Type': 'application/json' } })
        : new Response('{"error":"invalid_token"}', { status: 401 });
    }
    if (url.includes('/forms')) {
      return new Response('{"total":0,"count":0,"data":[],"next":null}', {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('not found', { status: 404 });
  };
  return createApp({
    config: { apiBaseUrl: 'https://api.test/api/v1', publicUrls: ['https://mcp.test'] },
    fetch: fetchImpl,
    authServerMetadata: AS
  });
}

test("no token: 401 with WWW-Authenticate pointing at this server's PRM", async () => {
  const res = await app({ count: 0 }).request('https://mcp.test/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  });
  assert.equal(res.status, 401);
  const challenge = res.headers.get('www-authenticate') ?? '';
  assert.match(challenge, /^Bearer /);
  assert.match(challenge, /resource_metadata="https:\/\/mcp\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test('API unreachable during token verification: 503, not a bare 500', async () => {
  const a = createApp({
    config: { apiBaseUrl: 'https://api.test/api/v1', publicUrls: ['https://mcp.test'] },
    fetch: async () => {
      throw new TypeError('Illegal invocation');
    },
    authServerMetadata: AS
  });
  const res = await a.request('https://mcp.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer x',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  });
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error_description: string }).error_description, /unreachable/);
});

test('deployed under a path prefix: the challenge and the PRM both carry the prefix of the public URL', async () => {
  const a = createApp({
    config: { apiBaseUrl: 'https://api.test/api/v1', publicUrls: ['https://host.test/jinshuju-mcp/'] },
    fetch: async () => new Response('{}', { status: 404 }),
    authServerMetadata: AS
  });
  // The platform strips the /jinshuju-mcp prefix before forwarding; the worker sees /mcp
  const res = await a.request('https://host.test/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  });
  assert.equal(res.status, 401);
  assert.match(
    res.headers.get('www-authenticate') ?? '',
    /resource_metadata="https:\/\/host\.test\/jinshuju-mcp\/\.well-known\/oauth-protected-resource\/mcp"/
  );
  const prm = await a.request('https://host.test/.well-known/oauth-protected-resource/mcp');
  assert.equal(((await prm.json()) as { resource: string }).resource, 'https://host.test/jinshuju-mcp/mcp');
  const home = (await (await a.request('https://host.test/')).json()) as { mcp: string };
  assert.equal(home.mcp, 'https://host.test/jinshuju-mcp/mcp');
});

test('several public URLs: chosen by the request Host, X-Forwarded-Host first, the first one when none matches', async () => {
  const a = createApp({
    config: {
      apiBaseUrl: 'https://api.test/api/v1',
      publicUrls: ['https://mcp.test', 'https://host.test/jinshuju-mcp']
    },
    fetch: async () => new Response('{}', { status: 404 }),
    authServerMetadata: AS
  });
  const resourceOf = async (res: Response) => ((await res.json()) as { resource: string }).resource;
  const prm = '/.well-known/oauth-protected-resource/mcp';
  // The platform forwards plain HTTP after TLS termination: neither scheme nor prefix can be inferred, so Host picks the URL
  const viaDefault = await a.request(`http://host.test${prm}`, { headers: { 'x-forwarded-proto': 'http' } });
  assert.equal(await resourceOf(viaDefault), 'https://host.test/jinshuju-mcp/mcp');
  assert.equal(await resourceOf(await a.request(`http://MCP.test${prm}`)), 'https://mcp.test/mcp');
  const forwarded = await a.request(`http://internal.test${prm}`, { headers: { 'x-forwarded-host': 'host.test' } });
  assert.equal(await resourceOf(forwarded), 'https://host.test/jinshuju-mcp/mcp');
  assert.equal(await resourceOf(await a.request(`https://other.test${prm}`)), 'https://mcp.test/mcp');
  // The 401 challenge follows the Host too
  const res = await a.request('http://host.test/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  });
  assert.equal(res.status, 401);
  assert.match(
    res.headers.get('www-authenticate') ?? '',
    /resource_metadata="https:\/\/host\.test\/jinshuju-mcp\/\.well-known\/oauth-protected-resource\/mcp"/
  );
});

test("no public URL configured: inferred from the request and the reverse proxy's X-Forwarded-* headers", async () => {
  const a = createApp({
    config: { apiBaseUrl: 'https://api.test/api/v1' },
    fetch: async () => new Response('{}', { status: 404 }),
    authServerMetadata: AS
  });
  const resourceOf = async (res: Response) => ((await res.json()) as { resource: string }).resource;
  const prm = '/.well-known/oauth-protected-resource/mcp';
  assert.equal(await resourceOf(await a.request(`http://localhost:8787${prm}`)), 'http://localhost:8787/mcp');
  const proxied = await a.request(`http://10.0.0.1${prm}`, {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mcp.test', 'x-forwarded-prefix': '/svc/' }
  });
  assert.equal(await resourceOf(proxied), 'https://mcp.test/svc/mcp');
});

test('PRM and AS metadata: served under both the /mcp path and the root', async () => {
  const a = app({ count: 0 });
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const res = await a.request(`https://mcp.test${path}`);
    assert.equal(res.status, 200, path);
    const prm = (await res.json()) as { resource: string; authorization_servers: string[] };
    assert.equal(prm.resource, 'https://mcp.test/mcp');
    assert.deepEqual(prm.authorization_servers, ['https://account.test']);
  }
  const as = await a.request('https://mcp.test/.well-known/oauth-authorization-server');
  assert.equal(((await as.json()) as { issuer: string }).issuer, 'https://account.test');
});

test('trailing slash: /mcp/ and the PRM paths work with a slash too', async () => {
  const a = app({ count: 0 });
  const unauth = await a.request('https://mcp.test/mcp/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  });
  assert.equal(unauth.status, 401);
  const prm = await a.request('https://mcp.test/.well-known/oauth-protected-resource/mcp/');
  assert.equal(((await prm.json()) as { resource: string }).resource, 'https://mcp.test/mcp');

  const transport = new StreamableHTTPClientTransport(new URL('https://mcp.test/mcp/'), {
    fetch: async (input, init) => a.request(input instanceof Request ? input : String(input), init),
    requestInit: { headers: { Authorization: 'Bearer good' } }
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === 'list_forms'));
  await client.close();
});

test('invalid token: 401; valid token: tools/list succeeds and the verification is cached', async () => {
  const me = { count: 0 };
  const a = app(me);
  const bad = await a.request('https://mcp.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer nope',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  });
  assert.equal(bad.status, 401);

  const transport = new StreamableHTTPClientTransport(new URL('https://mcp.test/mcp'), {
    fetch: async (input, init) => a.request(input instanceof Request ? input : String(input), init),
    requestInit: { headers: { Authorization: 'Bearer good' } }
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === 'list_forms'));
  const result = await client.callTool({ name: 'list_forms', arguments: { limit: 1 } });
  assert.equal(result.isError, undefined);
  await client.close();
  assert.equal(me.count, 2, 'one failure + one success, then a cache hit');
});

test('legacy (2025 handshake) client: initialize goes through the stateless fallback', async () => {
  const a = app({ count: 0 });
  const res = await a.request('https://mcp.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer good',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } }
    })
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /"serverInfo"/);
  assert.match(text, /"instructions"/);
});
