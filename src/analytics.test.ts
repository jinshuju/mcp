import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { callerTypeOf, classifyError, CONTEXT_DESCRIPTION, McpAnalytics, type ErrorType } from './analytics.js';
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

/** A fake Jinshuju API and a fake PostHog: both record their requests; events are read from the /batch/ request bodies. */
function harness(
  options: {
    analytics?: boolean;
    collectIntent?: boolean;
    me?: Response;
    /** The authorization server's token info; 401 (the token is not an OAuth token) by default */
    tokenInfo?: Response;
    /** The first /batch never answers (until posthog's requestTimeout aborts it); later ones are normal */
    hangFirstBatch?: boolean;
    /** Every /batch answers with this status */
    batchStatus?: number;
    requestTimeoutMs?: number;
  } = {}
) {
  const apiCalls: { url: string; body?: string }[] = [];
  const batches: { api_key: string; batch: Captured[] }[] = [];
  let batchCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.includes('/batch')) {
      if (options.hangFirstBatch && ++batchCalls === 1) {
        return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      if (options.batchStatus)
        return new Response('{"status":0}', { status: options.batchStatus, headers: JSON_HEADERS });
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
    if (url === 'https://account.test/oauth/token/info') {
      return options.tokenInfo?.clone() ?? new Response('{"error":"invalid_token"}', { status: 401 });
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
    return new Response('{"error":"not_found","error_description":"form cannot be found"}', {
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
          fetch: fetchImpl,
          requestTimeoutMs: options.requestTimeoutMs
        });
  const app = createApp({
    config: {
      apiBaseUrl: 'https://api.test/api/v1',
      authServer: 'https://account.test',
      publicUrls: ['https://mcp.test']
    },
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

/** The 2025 legacy handshake: plain JSON-RPC with MCP-Protocol-Version and the Mcp-Session-Id the client replays. */
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

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

test('no generated tool declares a context argument of its own: the name is reserved for analytics', () => {
  for (const tool of TOOLS)
    assert.equal(Object.keys(tool.inputSchema.properties ?? {}).includes('context'), false, tool.name);
});

test('legacy handshake: only initialize and tool_call are reported, argument names without values, intent from context, one session per token', async () => {
  const h = harness();
  const init = await legacy(h.app, INITIALIZE);
  assert.equal(init.res.status, 200);
  assert.match(String(init.json?.result?.instructions), /`context` argument/);
  // A stateless server has no session; the PostHog SDK mints an Mcp-Session-Id carrying the client name and version on initialize, and the client replays it
  const sessionHeader = init.res.headers.get('mcp-session-id');
  assert.ok(sessionHeader, 'the initialize response carries Mcp-Session-Id');
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
    'with context added, additionalProperties can no longer be false'
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
  assert.doesNotMatch(h.apiCalls[0].url, /context/, 'context never reaches the API');

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
  const invalid = await legacy(
    h.app,
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'list_forms', arguments: { limit: 'ten', context: '列出十个表单' } }
    },
    replay
  );
  assert.equal(invalid.json?.result?.isError, true);
  assert.equal(h.apiCalls.length, 2, 'invalid arguments never reach the API');

  // A repeated handshake on the same connection is not reported again
  await legacy(h.app, { ...INITIALIZE, id: 6 });

  const events = await h.events();
  assert.deepEqual(
    events.map((e) => e.event),
    ['$mcp_initialize', '$mcp_tool_call', '$mcp_tool_call', '$mcp_tool_call'],
    'no event for tools/list, $identify or the repeated handshake'
  );
  for (const e of events) {
    assert.equal(e.distinct_id, 'u1');
    assert.equal(e.properties.$mcp_source, 'posthog_mcp_analytics');
    assert.equal(e.properties.$mcp_server_name, 'jinshuju');
    assert.equal(e.properties.$mcp_server_version, VERSION);
    assert.equal(e.properties.mcp_caller_type, 'external');
    assert.match(String(e.properties.$session_id), /^ses_[0-9a-f]{32}$/);
    assert.equal(e.properties.$session_id, events[0].properties.$session_id, 'one token, one session');
  }
  const [initialize, call, failure, rejected] = events;
  assert.equal(initialize.properties.$mcp_client_name, 'claude-ai');
  assert.equal(initialize.properties.$mcp_client_version, '0.1.0');
  assert.equal(initialize.properties.$mcp_protocol_version, '2025-06-18');
  assert.equal(call.properties.$mcp_tool_name, 'list_forms');
  assert.deepEqual(call.properties.$mcp_input_keys, ['q']);
  assert.equal(call.properties.$mcp_intent, '找上周的报名表');
  assert.equal(call.properties.$mcp_intent_source, 'context_parameter');
  assert.equal(call.properties.$mcp_is_error, false);
  assert.equal(typeof call.properties.$mcp_duration_ms, 'number');
  assert.equal(
    call.properties.$mcp_client_name,
    'claude-ai',
    'the tool call recognizes the client from the replayed Mcp-Session-Id'
  );
  assert.equal(failure.properties.$mcp_tool_name, 'get_form');
  assert.equal(failure.properties.$mcp_is_error, true);
  assert.match(String(failure.properties.$mcp_error_message), /form cannot be found|404/);
  assert.equal(failure.properties.$mcp_error_type, 'api_4xx', 'an isError result is bucketed, not typed "Error"');
  assert.equal(failure.properties.$mcp_error_status, 404);
  assert.equal(rejected.properties.$mcp_tool_name, 'list_forms');
  assert.equal(rejected.properties.$mcp_is_error, true);
  assert.equal(rejected.properties.$mcp_error_type, 'validation');
  assert.equal('$mcp_error_status' in rejected.properties, false, 'no HTTP status when nothing was sent');
  const wire = JSON.stringify(h.batches);
  assert.doesNotMatch(wire, /13800138000/, 'argument values are not recorded');
  assert.doesNotMatch(wire, /秘密表单/, 'results are not recorded');
  for (const key of ['$mcp_parameters', '$mcp_response', '$mcp_tool_description'])
    assert.doesNotMatch(wire, new RegExp(`"\\${key}"`));
});

test("2026-07-28 stateless client: client info comes from each request's _meta, and the session is still derived from the token", async () => {
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
  // The same token gets the same session id over the legacy handshake
  const old = harness();
  await legacy(old.app, INITIALIZE);
  assert.equal((await old.events())[0].properties.$session_id, call.properties.$session_id);
});

test('intent capture off: context is no longer advertised; a context the client still sends is accepted but not reported', async () => {
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

test('without PostHog: no context argument, receiving one is not an error, and nothing is reported', async () => {
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

test('neither GET /me nor the token info names the user: events are anonymous and no person is created', async () => {
  const h = harness({ me: new Response('{"error":"forbidden"}', { status: 403, headers: JSON_HEADERS }) });
  await legacy(h.app, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_forms', arguments: {} } });
  const [call] = await h.events();
  assert.equal(call.event, '$mcp_tool_call');
  assert.equal(call.distinct_id, call.properties.$session_id);
  assert.equal(call.properties.$process_person_profile, false);
});

test('an OAuth token without the users scope: the user comes from the token info', async () => {
  const h = harness({
    me: new Response('{"error_description":"OAuth token scope is insufficient"}', {
      status: 403,
      headers: JSON_HEADERS
    }),
    tokenInfo: new Response('{"resource_owner_id":"u1","scope":["forms"],"expires_in":7200}', { headers: JSON_HEADERS })
  });
  await legacy(h.app, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_forms', arguments: {} } });
  const [call] = await h.events();
  assert.equal(call.event, '$mcp_tool_call');
  assert.equal(call.distinct_id, 'u1');
  assert.match(String(call.properties.$session_id), /^ses_[0-9a-f]{32}$/);
  assert.notEqual(call.properties.$process_person_profile, false);
});

test("a PostHog client per request: one request's stuck upload does not hold up the next request's events", async () => {
  const h = harness({ hangFirstBatch: true, requestTimeoutMs: 200 });
  const init = await legacy(h.app, INITIALIZE); // this request's flush hangs on the first /batch
  const replay = { 'Mcp-Session-Id': init.res.headers.get('mcp-session-id')! };
  const call = await legacy(
    h.app,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_forms', arguments: { limit: 1, context: '看看表单' } }
    },
    replay
  );
  assert.equal(call.res.status, 200);
  await until(() => h.batches.length >= 1);
  // The second request's tool_call arrives first: with a shared client it would queue behind the stuck initialize
  assert.deepEqual(
    h.batches[0].batch.map((e) => e.event),
    ['$mcp_tool_call']
  );
  // After the retry the initialize arrives too. posthog's request timeout timer is unref'd, so awaiting flush() alone
  // lets the event loop drain on Node 20 / 22 and the test is cancelled; until()'s polling timer keeps the loop alive until the retry is done.
  await until(() => h.batches.some((b) => b.batch.some((e) => e.event === '$mcp_initialize')), 3000);
  await h.analytics?.flush(); // don't leave timers to the next test
});

test('PostHog rejects the batch: the failure is logged to the console (and reaches Sentry in production) and the tool result is unaffected', async () => {
  const h = harness({ batchStatus: 500 });
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const init = await legacy(h.app, INITIALIZE);
    assert.equal(init.res.status, 200);
    await h.analytics?.flush();
  } finally {
    console.error = original;
  }
  assert.ok(
    logged.some((args) => String(args[0]).includes('posthog flush failed')),
    `no log of the failed upload: ${JSON.stringify(logged.map((a) => String(a[0])))}`
  );
});

test('error buckets: API failures by status, a 403 naming the scope as permission, argument problems as validation, the rest by transport', () => {
  const cases: [string, ErrorType, number?][] = [
    [
      'HTTP 404: get_form failed.\nform cannot be found\nThe resource does not exist or this credential cannot access it (check the token / serial number).',
      'api_4xx',
      404
    ],
    [
      'HTTP 400: list_entries failed.\nUnknown field api_code(s): field_3.\nArguments or data failed validation: fix them as described above and retry.',
      'api_4xx',
      400
    ],
    [
      'HTTP 401: list_forms failed.\nThe credential is invalid or expired: re-authorize, or use another access token.',
      'api_4xx',
      401
    ],
    [
      'HTTP 403: list_forms failed.\nOAuth token scope is insufficient\nNo permission, a quota is used up, or the OAuth scope is insufficient.',
      'permission',
      403
    ],
    [
      'HTTP 403: list_forms failed.\nNo permission, a quota is used up, or the OAuth scope is insufficient.',
      'api_4xx',
      403
    ],
    [
      'HTTP 403: create_entry failed.\nThe quota of entries is used up\nNo permission, a quota is used up, or the OAuth scope is insufficient.',
      'api_4xx',
      403
    ],
    [
      'HTTP 429: search_entries_in_forms failed.\nrate limit exceeded\nRate limit exceeded; retry in 30 seconds.',
      'rate_limited',
      429
    ],
    [
      'HTTP 502: list_forms failed.\n<html>bad gateway</html>\nJinshuju server error; retry later, and report it if it keeps happening.',
      'api_5xx',
      502
    ],
    [
      'HTTP 500: list_forms failed.\nJinshuju server error; retry later, and report it if it keeps happening.\n⚠ Server warnings about the arguments (X-API-Input-Warnings): scope ignored',
      'api_5xx',
      500
    ],
    [
      'Input validation error: Invalid arguments for tool list_entries: limit: Instance type "string" is invalid. Expected "integer".',
      'validation'
    ],
    [
      'Input validation error: Invalid arguments for tool get_form: Unknown arguments: token. This tool accepts only: form_token',
      'validation'
    ],
    ['Unknown arguments: report. This tool accepts only: name, fields', 'validation'],
    ['form_token: Instance does not have required property "form_token".', 'validation'],
    ['No schema named textfield. Similar names: TextFieldInput', 'validation'],
    ['Nothing to change: pass exam_setting or form fields.', 'validation'],
    ['Request timed out (GET /forms): The operation was aborted. Retry later.', 'timeout'],
    ['Could not reach the Jinshuju API (GET /forms): fetch failed. Retry later.', 'internal'],
    ['TypeError: Cannot read properties of undefined', 'internal'],
    ['', 'internal']
  ];
  for (const [message, type, status] of cases)
    assert.deepEqual(classifyError(message), status === undefined ? { type } : { type, status }, message);
});

test('caller type: the Python MCP SDK defaults Jiri still uses are jiri, everything else is external', () => {
  assert.equal(callerTypeOf('mcp', 'python-httpx/0.28.1'), 'jiri');
  assert.equal(callerTypeOf('mcp', 'node'), 'external');
  assert.equal(callerTypeOf('claude-ai', 'python-httpx/0.28.1'), 'external');
  assert.equal(callerTypeOf(undefined, undefined), 'external');
});

test("Jiri's remaining path (client name mcp over python-httpx) is reported with caller type jiri and its user agent", async () => {
  const h = harness();
  const agent = { 'User-Agent': 'python-httpx/0.28.1' };
  const init = await legacy(
    h.app,
    { ...INITIALIZE, params: { ...INITIALIZE.params, clientInfo: { name: 'mcp', version: '0.1.0' } } },
    agent
  );
  const replay = { ...agent, 'Mcp-Session-Id': init.res.headers.get('mcp-session-id')! };
  await legacy(
    h.app,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_form', arguments: { form_token: 'AbCdEf', context: '读表单' } }
    },
    replay
  );
  const events = await h.events();
  assert.deepEqual(
    events.map((e) => e.event),
    ['$mcp_initialize', '$mcp_tool_call']
  );
  for (const e of events) {
    assert.equal(e.properties.$mcp_client_name, 'mcp');
    assert.equal(e.properties.$mcp_client_user_agent, 'python-httpx/0.28.1');
    assert.equal(e.properties.mcp_caller_type, 'jiri');
  }
});
