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
  userAgent: string | null;
  body?: string;
}

function fakeApi(respond: (req: Recorded) => Response) {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const rec: Recorded = {
      method: init?.method ?? 'GET',
      url: String(input),
      auth: new Headers(init?.headers).get('authorization'),
      userAgent: new Headers(init?.headers).get('user-agent'),
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

test('tools/list: the generated tools plus get_schema, with annotations and outputSchema', async () => {
  const { client, close } = await connect(fakeApi(() => new Response('{}')).fetchImpl);
  const { tools } = await client.listTools();
  assert.equal(tools.length, TOOLS.length + 1);
  const listForms = tools.find((t) => t.name === 'list_forms')!;
  assert.equal(listForms.annotations?.readOnlyHint, true);
  const withOutput = TOOLS.filter((t) => t.outputSchema);
  assert.ok(withOutput.length > 0, 'at least some tools carry an outputSchema in tools/list');
  for (const spec of withOutput) assert.ok(tools.find((t) => t.name === spec.name)?.outputSchema, spec.name);
  assert.ok(tools.find((t) => t.name === 'get_schema'));
  const createForm = tools.find((t) => t.name === 'create_form')!;
  assert.equal(createForm.outputSchema, undefined, 'the Form response contains FieldDefinition, so it is not sent');
  assert.match(createForm.description ?? '', /get_schema/);
  await close();
});

test('tools/call: arguments are checked against the JSON Schema, and no request is sent when they are invalid', async () => {
  const { calls, fetchImpl } = fakeApi(() => new Response('{}'));
  const { client, close } = await connect(fetchImpl);
  const result = await client.callTool({ name: 'list_entries', arguments: { limit: 'ten' } });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /form_token|limit/);
  await close();
});

test('tools/call: extra keys are named, along with the arguments the tool accepts', async () => {
  const { calls, fetchImpl } = fakeApi(() => new Response('{}'));
  const { client, close } = await connect(fetchImpl);
  const result = await client.callTool({
    name: 'create_evaluation_form',
    arguments: { name: '职场压力自测', scene: 'evaluation', report: { enabled: true }, fields: [] }
  });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /Unknown arguments: report\./);
  assert.match(text, /accepts only: .*name.*fields.*evaluation_setting/);
  assert.doesNotMatch(text, /additional properties/);

  const typed = await client.callTool({ name: 'list_entries', arguments: { form_token: 'AbCdEf', limit: 'ten' } });
  assert.equal(typed.isError, true);
  assert.match((typed.content[0] as { text: string }).text, /: limit: Instance type "string" is invalid/);

  // scene is accepted on the create tools, but only as the tool's own scene
  const wrongScene = await client.callTool({
    name: 'create_evaluation_form',
    arguments: { name: '职场压力自测', scene: 'exam', fields: [] }
  });
  assert.equal(wrongScene.isError, true);
  assert.equal(calls.length, 0);
  await close();
});

test('tools/call: filters and the other JSON-text parameters are accepted as the array or as its JSON text, and reach the API as one JSON value', async () => {
  const { calls, fetchImpl } = fakeApi(
    () =>
      new Response('{"total":0,"count":0,"data":[],"next":null}', { headers: { 'Content-Type': 'application/json' } })
  );
  const { client, close } = await connect(fetchImpl);
  const filters = [{ field: 'field_3', operator: 'any_in', value: ['选项 A'] }];
  const sort = [{ api_code: 'created_at', order: 'desc' }];
  const asArrays = await client.callTool({ name: 'list_entries', arguments: { form_token: 'AbCdEf', filters, sort } });
  assert.equal(asArrays.isError, undefined);
  const asText = await client.callTool({
    name: 'list_entries',
    arguments: { form_token: 'AbCdEf', filters: JSON.stringify(filters), sort: JSON.stringify(sort) }
  });
  assert.equal(asText.isError, undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(new URL(calls[0].url).searchParams.get('filters'), JSON.stringify(filters));
  assert.equal(new URL(calls[0].url).searchParams.get('sort'), JSON.stringify(sort));

  // Neither: a bare object, or an item without the keys ScopeCondition requires, is refused before any request
  const object = await client.callTool({
    name: 'list_entries',
    arguments: { form_token: 'AbCdEf', filters: { field: 'field_3', operator: 'eq', value: 1 } }
  });
  assert.equal(object.isError, true);
  assert.match((object.content[0] as { text: string }).text, /filters/);
  const incomplete = await client.callTool({
    name: 'list_entries',
    arguments: { form_token: 'AbCdEf', filters: [{ operator: 'eq', value: 1 }] }
  });
  assert.equal(incomplete.isError, true);
  assert.match((incomplete.content[0] as { text: string }).text, /filters.*field/);
  assert.equal(calls.length, 2);
  await close();
});

test('tools/call: success returns text (plus structuredContent when there is an outputSchema) and sends Bearer and User-Agent', async () => {
  const payload = { total: 1, count: 1, data: [{ name: '报名表', token: 'AbCdEf' }], next: null };
  const { calls, fetchImpl } = fakeApi(
    () => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
  );
  const { client, close } = await connect(fetchImpl);
  const result = await client.callTool({ name: 'list_forms', arguments: { limit: 1 } });
  assert.equal(result.isError, undefined);
  assert.equal(calls[0].url, 'https://api.test/api/v1/forms?limit=1');
  assert.equal(calls[0].auth, 'Bearer tok');
  // Jinshuju records forms created through MCP as create_source=mcp (not api) by this prefix; keep it when changing the UA
  assert.match(calls[0].userAgent ?? '', /^jinshuju-mcp\//);
  assert.equal((result.content[0] as { text: string }).text, JSON.stringify(payload));
  const spec = TOOLS.find((t) => t.name === 'list_forms')!;
  assert.deepEqual(result.structuredContent, spec.outputSchema ? payload : undefined);

  const counted = TOOLS.find((t) => t.name === 'count_entries')!;
  assert.ok(counted.outputSchema, "count_entries's response is small, so it carries an outputSchema");
  const count = await client.callTool({ name: 'count_entries', arguments: { form_token: 'AbCdEf' } });
  assert.deepEqual(count.structuredContent, payload);
  await close();
});

test('tools/call: an API 400 becomes a tool error with error_description / errors', async () => {
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

test('composite tools: create_exam_form creates the form, then writes the settings; edit_exam_form writes the settings, then edits the form; count_entries dispatches on its input', async () => {
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
    arguments: {
      name: '期末考试',
      scene: 'exam',
      fields: [{ type: 'SingleSelect', label: 'Q1' }],
      exam_setting: { limited_time: 45 }
    }
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
  assert.match((created.content[0] as { text: string }).text, /Exam settings updated/);

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
  const window = [{ field: 'created_at', operator: 'within_last', value: { unit: 'day', n: 7 } }];
  await client.callTool({ name: 'count_entries', arguments: { form_token: ['A', 'B'], filters: window } });
  assert.equal(new URL(calls[2].url).pathname, '/api/v1/entries/count');
  assert.equal(new URL(calls[2].url).searchParams.get('filters'), JSON.stringify(window));

  calls.length = 0;
  await client.callTool({ name: 'edit_field_rules', arguments: { form_token: 'T1', remove: [0] } });
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].body, '{"field_rules":{"remove":[0]}}');
  await close();
});

test('composite tools: the evaluation settings go as the whole JSON body (updateEvaluationSetting is not flattened)', async () => {
  // Found by the evals: the evaluation settings body is an EvaluationSettingInput pointer (body.param); flattening it like the exam settings sent an empty body (HTTP 415).
  const { calls, fetchImpl } = fakeApi((req) =>
    req.method === 'POST' && req.url.endsWith('/forms')
      ? new Response('{"token":"EvalTok"}', { status: 201, headers: { 'Content-Type': 'application/json' } })
      : new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })
  );
  const { client, close } = await connect(fetchImpl);
  const setting = {
    notice_after_filling_mode: 'reports',
    evaluation_comments: [{ start_point: 0, end_point: 8, comment: '低' }]
  };
  const created = await client.callTool({
    name: 'create_evaluation_form',
    arguments: { name: '压力自测', fields: [{ type: 'SingleSelect', label: 'Q1' }], evaluation_setting: setting }
  });
  assert.equal(created.isError, undefined);
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url, 'https://api.test/api/v1/forms/EvalTok/evaluation_setting');
  assert.deepEqual(JSON.parse(calls[1].body!), setting);

  calls.length = 0;
  await client.callTool({
    name: 'edit_evaluation_form',
    arguments: { form_token: 'T2', evaluation_setting: { show_report_score: true } }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.test/api/v1/forms/T2/evaluation_setting');
  assert.equal(calls[0].body, '{"show_report_score":true}');
  await close();
});

test("composite tools: when create_exam_form's settings are rejected, the result says the form was created", async () => {
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
  assert.match(text, /The form was created \(token=NewTok\)/);
  assert.match(text, /not an exam form/);
  await close();
});

test("tools/call: the body is sent under the overlay's key, and a 429 carries the Retry-After hint", async () => {
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
  assert.match((result.content[0] as { text: string }).text, /retry in 30 seconds/);
  await close();
});

test('tools/call: an oversized result is truncated with a hint to page', async () => {
  const big = { data: Array.from({ length: 500 }, (_, i) => ({ i, text: 'x'.repeat(50) })) };
  const { fetchImpl } = fakeApi(() => new Response(JSON.stringify(big)));
  const { client, close } = await connect(fetchImpl, 2000);
  const result = await client.callTool({ name: 'list_entries', arguments: { form_token: 'AbCdEf' } });
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /Result truncated/);
  assert.ok(text.length < 2500);
  const spec = TOOLS.find((t) => t.name === 'list_entries')!;
  if (spec.outputSchema) assert.equal((result.structuredContent as { truncated: boolean }).truncated, true);
  else assert.equal(result.structuredContent, undefined);
  await close();
});

test('get_schema and resources: pointer schemas can be read, and an unknown name gets suggestions', async () => {
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
