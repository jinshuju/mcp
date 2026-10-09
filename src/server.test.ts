import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { buildServer } from './server.js';
import { StaticCredential } from './credential.js';
import { TOOLS } from './tools.js';

interface Recorded {
  method: string;
  url: string;
  auth: string | null;
  body?: string;
}

function fakeApi(respond: (req: Recorded) => Response) {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const rec: Recorded = {
      method: init?.method ?? 'GET',
      url: String(input),
      auth: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? init.body : undefined
    };
    calls.push(rec);
    return respond(rec);
  };
  return { calls, fetchImpl };
}

async function connect(fetchImpl: typeof fetch, maxResultChars = 120_000) {
  const server = buildServer({
    credential: new StaticCredential('tok'),
    config: { apiBaseUrl: 'https://api.test/api/v1', maxResultChars },
    fetch: fetchImpl
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return { client, close: async () => await client.close() };
}

test('tools/list：生成的工具 + get_schema，带注解与 outputSchema', async () => {
  const { client, close } = await connect(fakeApi(() => new Response('{}')).fetchImpl);
  const { tools } = await client.listTools();
  assert.equal(tools.length, TOOLS.length + 1);
  const listForms = tools.find((t) => t.name === 'list_forms')!;
  assert.equal(listForms.annotations?.readOnlyHint, true);
  const withOutput = TOOLS.filter((t) => t.outputSchema);
  assert.ok(withOutput.length > 0, '至少有一部分工具随 tools/list 下发 outputSchema');
  for (const spec of withOutput) assert.ok(tools.find((t) => t.name === spec.name)?.outputSchema, spec.name);
  assert.ok(tools.find((t) => t.name === 'get_schema'));
  const createForm = tools.find((t) => t.name === 'create_form')!;
  assert.equal(createForm.outputSchema, undefined, 'Form 响应含 FieldDefinition，不下发');
  assert.match(createForm.description ?? '', /get_schema/);
  await close();
});

test('tools/call：参数经 JSON Schema 校验，不合法时不发请求', async () => {
  const { calls, fetchImpl } = fakeApi(() => new Response('{}'));
  const { client, close } = await connect(fetchImpl);
  const result = await client.callTool({ name: 'list_entries', arguments: { limit: 'ten' } });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /form_token|limit/);
  await close();
});

test('tools/call：成功时返回文本（有 outputSchema 的再给 structuredContent），并带 Bearer', async () => {
  const payload = { total: 1, count: 1, data: [{ name: '报名表', token: 'AbCdEf' }], next: null };
  const { calls, fetchImpl } = fakeApi(
    () => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
  );
  const { client, close } = await connect(fetchImpl);
  const result = await client.callTool({ name: 'list_forms', arguments: { limit: 1 } });
  assert.equal(result.isError, undefined);
  assert.equal(calls[0].url, 'https://api.test/api/v1/forms?limit=1');
  assert.equal(calls[0].auth, 'Bearer tok');
  assert.equal((result.content[0] as { text: string }).text, JSON.stringify(payload));
  const spec = TOOLS.find((t) => t.name === 'list_forms')!;
  assert.deepEqual(result.structuredContent, spec.outputSchema ? payload : undefined);

  const counted = TOOLS.find((t) => t.name === 'count_entries')!;
  assert.ok(counted.outputSchema, 'count_entries 的响应很小，应带 outputSchema');
  const count = await client.callTool({ name: 'count_entries', arguments: { form_token: 'AbCdEf' } });
  assert.deepEqual(count.structuredContent, payload);
  await close();
});

test('tools/call：API 400 翻译成带 error_description / errors 的工具错误', async () => {
  const { fetchImpl } = fakeApi(
    () =>
      new Response(
        JSON.stringify({
          error_description: 'Validation failed',
          errors: [{ pointer: '/limit', message: 'must be <= 1000', code: 'maximum' }]
        }),
        { status: 400, headers: { 'Content-Type': 'application/json', 'X-API-Input-Warnings': 'limit: too big' } }
      )
  );
  const { client, close } = await connect(fetchImpl);
  const result = await client.callTool({ name: 'list_forms', arguments: { limit: 5 } });
  assert.equal(result.isError, true);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /HTTP 400/);
  assert.match(text, /Validation failed/);
  assert.match(text, /\/limit: must be <= 1000 \(maximum\)/);
  assert.match(text, /X-API-Input-Warnings/);
  await close();
});

test('组合工具：create_exam_form 先建表单再写设置；edit_exam_form 先写设置再改表单；count_entries 按入参分发', async () => {
  const { calls, fetchImpl } = fakeApi((req) => {
    if (req.method === 'POST' && req.url.endsWith('/forms')) {
      return new Response('{"token":"NewTok","name":"期末考试"}', {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  });
  const { client, close } = await connect(fetchImpl);
  const created = await client.callTool({
    name: 'create_exam_form',
    arguments: { name: '期末考试', fields: [{ type: 'SingleSelect', label: 'Q1' }], exam_setting: { limited_time: 45 } }
  });
  assert.equal(created.isError, undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.test/api/v1/forms');
  assert.deepEqual(JSON.parse(calls[0].body!), {
    name: '期末考试',
    fields: [{ type: 'SingleSelect', label: 'Q1' }],
    scene: 'exam'
  });
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url, 'https://api.test/api/v1/forms/NewTok/exam_setting');
  assert.equal(calls[1].body, '{"limited_time":45}');
  assert.match((created.content[0] as { text: string }).text, /考试设置已更新/);

  calls.length = 0;
  await client.callTool({
    name: 'edit_exam_form',
    arguments: { form_token: 'T1', name: '新名字', exam_setting: { show_timeout: true } }
  });
  assert.equal(calls[0].url, 'https://api.test/api/v1/forms/T1/exam_setting');
  assert.equal(calls[1].url, 'https://api.test/api/v1/forms/T1');
  assert.equal(calls[1].body, '{"name":"新名字"}');

  calls.length = 0;
  await client.callTool({ name: 'count_entries', arguments: { form_token: ['A', 'B'], filters: '[]' } });
  assert.equal(calls[0].url, 'https://api.test/api/v1/entries/count?form_tokens=A%2CB&filters=%5B%5D');
  await client.callTool({ name: 'count_entries', arguments: { form_token: 'A', keyword: 'x' } });
  assert.equal(calls[1].url, 'https://api.test/api/v1/forms/A/entries/count?keyword=x');

  calls.length = 0;
  await client.callTool({ name: 'edit_field_rules', arguments: { form_token: 'T1', remove: [0] } });
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].body, '{"field_rules":{"remove":[0]}}');
  await close();
});

test('组合工具：create_exam_form 的设置被拒绝时说明表单已创建', async () => {
  const { fetchImpl } = fakeApi((req) =>
    req.url.endsWith('/forms')
      ? new Response('{"token":"NewTok"}', { status: 201, headers: { 'Content-Type': 'application/json' } })
      : new Response('{"error_description":"not an exam form"}', {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
  );
  const { client, close } = await connect(fetchImpl);
  const result = await client.callTool({
    name: 'create_exam_form',
    arguments: { name: 'x', fields: [{ type: 'SingleSelect', label: 'Q1' }], exam_setting: { limited_time: 1 } }
  });
  assert.equal(result.isError, true);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /表单已创建（token=NewTok）/);
  assert.match(text, /not an exam form/);
  await close();
});

test('tools/call：请求体用 overlay 的键名发出，429 带 Retry-After 提示', async () => {
  const { calls, fetchImpl } = fakeApi((req) =>
    req.method === 'POST'
      ? new Response('{"error_description":"rate limited"}', { status: 429, headers: { 'Retry-After': '30' } })
      : new Response('{}')
  );
  const { client, close } = await connect(fetchImpl);
  const result = await client.callTool({
    name: 'create_entry',
    arguments: { form_token: 'AbCdEf', entry: { field_1: '张三' } }
  });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, '{"field_1":"张三"}');
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /30 秒后重试/);
  await close();
});

test('tools/call：超长结果被截断并提示分页', async () => {
  const big = { data: Array.from({ length: 500 }, (_, i) => ({ i, text: 'x'.repeat(50) })) };
  const { fetchImpl } = fakeApi(() => new Response(JSON.stringify(big)));
  const { client, close } = await connect(fetchImpl, 2000);
  const result = await client.callTool({ name: 'list_entries', arguments: { form_token: 'AbCdEf' } });
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /结果已截断/);
  assert.ok(text.length < 2500);
  const spec = TOOLS.find((t) => t.name === 'list_entries')!;
  if (spec.outputSchema) assert.equal((result.structuredContent as { truncated: boolean }).truncated, true);
  else assert.equal(result.structuredContent, undefined);
  await close();
});

test('get_schema 与 resources：能读到指针 schema，未知名字给出候选', async () => {
  const { client, close } = await connect(fakeApi(() => new Response('{}')).fetchImpl);
  const ok = await client.callTool({ name: 'get_schema', arguments: { name: 'FieldInput' } });
  const schema = JSON.parse((ok.content[0] as { text: string }).text);
  assert.equal(schema['x-variants'].TextField, 'TextFieldInput');
  const bad = await client.callTool({ name: 'get_schema', arguments: { name: 'textfield' } });
  assert.equal(bad.isError, true);
  assert.match((bad.content[0] as { text: string }).text, /TextFieldInput/);
  const { resources } = await client.listResources();
  assert.ok(resources.some((r) => r.uri === 'jinshuju://schemas/FieldInput'));
  const read = await client.readResource({ uri: 'jinshuju://schemas/TextFieldInput' });
  assert.equal(JSON.parse((read.contents[0] as { text: string }).text).type, 'object');
  await close();
});
