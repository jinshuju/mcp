import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CONTEXT_DESCRIPTION, McpAnalytics } from './analytics.js';
import { createApp } from './app.js';
import { TOOLS } from './tools.js';
import { VERSION } from './version.js';

const AS = {
  issuer: 'https://account.test',
  authorization_endpoint: 'https://account.test/oauth/authorize',
  token_endpoint: 'https://account.test/oauth/token',
  response_types_supported: ['code']
};
const JSON_HEADERS = { 'Content-Type': 'application/json' };

interface Captured {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
}

/** 假的金数据 API + 假的 PostHog：两边的请求都记下来，埋点内容从 /batch/ 的请求体里读。 */
function harness(options: { analytics?: boolean; collectIntent?: boolean; me?: Response } = {}) {
  const apiCalls: { url: string; body?: string }[] = [];
  const batches: { api_key: string; batch: Captured[] }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.includes('/batch')) {
      const raw = init?.body;
      const text =
        typeof raw === 'string'
          ? raw
          : headers.get('content-encoding') === 'gzip'
            ? gunzipSync(Buffer.from(raw as Uint8Array)).toString('utf8')
            : Buffer.from(raw as Uint8Array).toString('utf8');
      batches.push(JSON.parse(text));
      return new Response('{"status":1}', { headers: JSON_HEADERS });
    }
    if (url.endsWith('/me')) {
      if (headers.get('authorization') !== 'Bearer good')
        return new Response('{"error":"invalid_token"}', { status: 401 });
      return options.me?.clone() ?? new Response('{"id":"u1","name":"周"}', { headers: JSON_HEADERS });
    }
    apiCalls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (/\/forms(\?|$)/.test(url)) {
      return new Response('{"total":1,"count":1,"data":[{"token":"ABcdEf","name":"秘密表单"}],"next":null}', {
        headers: JSON_HEADERS
      });
    }
    return new Response('{"error":"not_found","error_description":"表单不存在"}', {
      status: 404,
      headers: JSON_HEADERS
    });
  };
  const analytics =
    options.analytics === false
      ? null
      : new McpAnalytics({
          apiKey: 'phc_test',
          host: 'https://ph.test',
          collectIntent: options.collectIntent,
          fetch: fetchImpl
        });
  const app = createApp({
    config: { apiBaseUrl: 'https://api.test/api/v1', publicUrls: ['https://mcp.test'] },
    fetch: fetchImpl,
    authServerMetadata: AS,
    analytics
  });
  const events = async () => {
    await analytics?.flush();
    return batches.flatMap((b) => b.batch);
  };
  return { app, analytics, apiCalls, batches, events };
}

type App = ReturnType<typeof harness>['app'];

/** 2025 旧握手：裸 JSON-RPC，带 MCP-Protocol-Version 与（客户端回放的）Mcp-Session-Id。 */
async function legacy(app: App, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.request('https://mcp.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer good',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      ...headers
    },
    body: JSON.stringify(body)
  });
  return { res, json: res.status === 200 ? ((await res.json()) as { result?: Record<string, unknown> }) : undefined };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } }
};

function decodeSessionToken(value: string): Record<string, string> {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, string>;
}

async function modernClient(app: App) {
  const transport = new StreamableHTTPClientTransport(new URL('https://mcp.test/mcp'), {
    fetch: async (input, init) => app.request(input instanceof Request ? input : String(input), init),
    requestInit: { headers: { Authorization: 'Bearer good' } }
  });
  const client = new Client(
    { name: 'modern-client', version: '2.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  await client.connect(transport);
  return client;
}

test('没有一个生成的工具自己声明 context 参数：这个名字留给埋点用', () => {
  for (const tool of TOOLS)
    assert.equal(Object.keys(tool.inputSchema.properties ?? {}).includes('context'), false, tool.name);
});

test('旧握手：只报 initialize 与 tool_call，记参数名不记参数值，意图来自 context，同一令牌同一会话', async () => {
  const h = harness();
  const init = await legacy(h.app, INITIALIZE);
  assert.equal(init.res.status, 200);
  assert.match(String(init.json?.result?.instructions), /`context` argument/);
  // 无状态服务没有会话；PostHog SDK 在 initialize 时铸一个带客户端名字和版本的 Mcp-Session-Id，客户端之后会回放
  const sessionHeader = init.res.headers.get('mcp-session-id');
  assert.ok(sessionHeader, 'initialize 响应应带 Mcp-Session-Id');
  assert.equal(decodeSessionToken(sessionHeader).cn, 'claude-ai');
  const replay = { 'Mcp-Session-Id': sessionHeader };

  const list = await legacy(h.app, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, replay);
  const tools = list.json?.result?.tools as { name: string; inputSchema: Record<string, unknown> }[];
  const listForms = tools.find((t) => t.name === 'list_forms')!;
  const context = (listForms.inputSchema.properties as Record<string, { description: string }>).context;
  assert.equal(context?.description, CONTEXT_DESCRIPTION);
  assert.ok((listForms.inputSchema.required as string[]).includes('context'));
  assert.notEqual(
    listForms.inputSchema.additionalProperties,
    false,
    '加了 context 之后不能再是 additionalProperties: false'
  );

  const ok = await legacy(
    h.app,
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_forms', arguments: { q: '13800138000', context: '找上周的报名表' } }
    },
    replay
  );
  assert.equal(ok.json?.result?.isError, undefined);
  assert.equal(h.apiCalls.length, 1);
  assert.match(h.apiCalls[0].url, /q(%5B%5D|\[\])?=13800138000/);
  assert.doesNotMatch(h.apiCalls[0].url, /context/, 'context 不能流到 API');

  const failed = await legacy(
    h.app,
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_form', arguments: { form_token: 'nope', context: '看表单' } }
    },
    replay
  );
  assert.equal(failed.json?.result?.isError, true);

  // 同一个连接上的重复握手不再报
  await legacy(h.app, { ...INITIALIZE, id: 5 });

  const events = await h.events();
  assert.deepEqual(
    events.map((e) => e.event),
    ['$mcp_initialize', '$mcp_tool_call', '$mcp_tool_call'],
    'tools/list 不报，$identify 不报，重复握手不报'
  );
  for (const e of events) {
    assert.equal(e.distinct_id, 'u1');
    assert.equal(e.properties.$mcp_source, 'posthog_mcp_analytics');
    assert.equal(e.properties.$mcp_server_name, 'jinshuju');
    assert.equal(e.properties.$mcp_server_version, VERSION);
    assert.equal(e.properties.mcp_caller_type, 'external');
    assert.match(String(e.properties.$session_id), /^ses_[0-9a-f]{32}$/);
    assert.equal(e.properties.$session_id, events[0].properties.$session_id, '同一令牌同一会话');
  }
  const [initialize, call, failure] = events;
  assert.equal(initialize.properties.$mcp_client_name, 'claude-ai');
  assert.equal(initialize.properties.$mcp_client_version, '0.1.0');
  assert.equal(initialize.properties.$mcp_protocol_version, '2025-06-18');
  assert.equal(call.properties.$mcp_tool_name, 'list_forms');
  assert.deepEqual(call.properties.$mcp_input_keys, ['q']);
  assert.equal(call.properties.$mcp_intent, '找上周的报名表');
  assert.equal(call.properties.$mcp_intent_source, 'context_parameter');
  assert.equal(call.properties.$mcp_is_error, false);
  assert.equal(typeof call.properties.$mcp_duration_ms, 'number');
  assert.equal(call.properties.$mcp_client_name, 'claude-ai', '工具调用从回放的 Mcp-Session-Id 里认出客户端');
  assert.equal(failure.properties.$mcp_tool_name, 'get_form');
  assert.equal(failure.properties.$mcp_is_error, true);
  assert.match(String(failure.properties.$mcp_error_message), /表单不存在|404/);
  const wire = JSON.stringify(h.batches);
  assert.doesNotMatch(wire, /13800138000/, '不记参数值');
  assert.doesNotMatch(wire, /秘密表单/, '不记返回内容');
  for (const key of ['$mcp_parameters', '$mcp_response', '$mcp_tool_description'])
    assert.doesNotMatch(wire, new RegExp(`"\\${key}"`));
});

test('2026-07-28 无状态客户端：client 信息来自每个请求的 _meta，会话仍按令牌派生', async () => {
  const h = harness();
  const client = await modernClient(h.app);
  const { tools } = await client.listTools();
  assert.ok(tools.find((t) => t.name === 'get_form')?.inputSchema.properties?.context);
  const result = await client.callTool({ name: 'list_forms', arguments: { limit: 1, context: '列出表单' } });
  assert.equal(result.isError, undefined);
  await client.close();

  const events = await h.events();
  assert.deepEqual(
    events.map((e) => e.event),
    ['$mcp_tool_call']
  );
  const [call] = events;
  assert.equal(call.distinct_id, 'u1');
  assert.equal(call.properties.$mcp_client_name, 'modern-client');
  assert.equal(call.properties.$mcp_client_version, '2.0.0');
  assert.equal(call.properties.$mcp_protocol_version, '2026-07-28');
  assert.equal(call.properties.$mcp_intent, '列出表单');
  assert.deepEqual(call.properties.$mcp_input_keys, ['limit']);
  // 同一个令牌走旧握手得到的会话 id 与这里一致
  const old = harness();
  await legacy(old.app, INITIALIZE);
  assert.equal((await old.events())[0].properties.$session_id, call.properties.$session_id);
});

test('关掉意图采集：不再下发 context，客户端照旧发来的 context 仍被接受但不上报', async () => {
  const h = harness({ collectIntent: false });
  const init = await legacy(h.app, INITIALIZE);
  assert.doesNotMatch(String(init.json?.result?.instructions), /context/);
  const list = await legacy(h.app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = list.json?.result?.tools as { name: string; inputSchema: { properties: Record<string, unknown> } }[];
  assert.equal('context' in tools.find((t) => t.name === 'list_forms')!.inputSchema.properties, false);
  const ok = await legacy(h.app, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'list_forms', arguments: { limit: 1, context: '缓存的工具列表还在发' } }
  });
  assert.equal(ok.json?.result?.isError, undefined);
  assert.doesNotMatch(h.apiCalls[0].url, /context/);
  const call = (await h.events()).find((e) => e.event === '$mcp_tool_call')!;
  assert.equal(call.properties.$mcp_tool_name, 'list_forms');
  assert.equal('$mcp_intent' in call.properties, false);
});

test('不配 PostHog：没有 context 参数，收到也不报错，什么都不上报', async () => {
  const h = harness({ analytics: false });
  const list = await legacy(h.app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = list.json?.result?.tools as { name: string; inputSchema: { properties: Record<string, unknown> } }[];
  assert.equal('context' in tools.find((t) => t.name === 'list_forms')!.inputSchema.properties, false);
  const ok = await legacy(h.app, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'list_forms', arguments: { limit: 1, context: '照旧' } }
  });
  assert.equal(ok.json?.result?.isError, undefined);
  assert.equal(h.batches.length, 0);
});

test('GET /me 没给出用户：事件匿名，不建人', async () => {
  const h = harness({ me: new Response('{"error":"forbidden"}', { status: 403, headers: JSON_HEADERS }) });
  await legacy(h.app, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_forms', arguments: {} } });
  const [call] = await h.events();
  assert.equal(call.event, '$mcp_tool_call');
  assert.equal(call.distinct_id, call.properties.$session_id);
  assert.equal(call.properties.$process_person_profile, false);
});
