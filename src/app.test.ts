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
    config: { apiBaseUrl: 'https://api.test/api/v1', publicUrl: 'https://mcp.test' },
    fetch: fetchImpl,
    authServerMetadata: AS
  });
}

test('无令牌：401 + WWW-Authenticate 指向本服务的 PRM', async () => {
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

test('路径前缀部署：对外地址含前缀时，质询与 PRM 都按前缀给出', async () => {
  const a = createApp({
    config: { apiBaseUrl: 'https://api.test/api/v1', publicUrl: 'https://host.test/jinshuju-mcp/' },
    fetch: async () => new Response('{}', { status: 404 }),
    authServerMetadata: AS
  });
  // 平台把 /jinshuju-mcp 前缀剥掉后转发，worker 看到的是 /mcp
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

test('PRM 与 AS 元数据：/mcp 路径与根路径都能取到', async () => {
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

test('无效令牌：401；有效令牌：tools/list 成功且校验结果被缓存', async () => {
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
  assert.equal(me.count, 2, '一次失败 + 一次成功后缓存命中');
});

test('旧协议（2025 handshake）客户端：initialize 走无状态兜底', async () => {
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
