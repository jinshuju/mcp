import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUrl, buildBody, bodyPayload, JinshujuApi, TransportError } from './api.js';
import { StaticCredential } from './credential.js';
import { TOOLS } from './tools.js';
import type { ToolSpec } from './types.js';

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t])) as Record<string, ToolSpec>;
const base = 'https://api.test/api/v1';

test('buildUrl: encodes path parameters, omits empty query values, repeats a `type: array` parameter as name[]', () => {
  const url = buildUrl(base, byName.list_entries, {
    form_token: 'Ab Cd',
    limit: 5,
    keyword: '',
    filters: '[{"field":"x"}]',
    fields: undefined
  });
  assert.equal(url.pathname, '/api/v1/forms/Ab%20Cd/entries');
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(url.searchParams.get('filters'), '[{"field":"x"}]');
  assert.equal(url.searchParams.has('keyword'), false);
  const arrayTool: ToolSpec = {
    ...byName.list_forms,
    params: [{ name: 'tags', in: 'query', required: false, array: 'repeat' }]
  };
  const u2 = buildUrl(base, arrayTool, { tags: ['a', 'b'] });
  assert.equal(u2.search, '?tags%5B%5D=a&tags%5B%5D=b');
});

test('buildUrl: an array argument is sent as the text the spec describes, so array and string callers send the same query', () => {
  const filters = [{ field: 'x', operator: 'eq', value: 1 }];
  const sort = [{ api_code: 'created_at', order: 'desc' }];
  const structured = buildUrl(base, byName.list_entries, { form_token: 'T', filters, sort, fields: ['a', 'b'] });
  const serialized = buildUrl(base, byName.list_entries, {
    form_token: 'T',
    filters: JSON.stringify(filters),
    sort: JSON.stringify(sort),
    fields: 'a,b'
  });
  assert.equal(structured.search, serialized.search);
  assert.equal(structured.searchParams.get('filters'), '[{"field":"x","operator":"eq","value":1}]');
  assert.equal(structured.searchParams.get('fields'), 'a,b');
  const search = buildUrl(base, byName.search_entries_in_forms, { form_tokens: ['A', 'B'], filters: [] });
  assert.equal(search.searchParams.get('form_tokens'), 'A,B');
  assert.equal(search.searchParams.get('filters'), '[]');
  const checks = buildUrl(base, byName.check_field_data, { form_token: 'T', checks: [{ field_api_code: 'field_1' }] });
  assert.equal(checks.searchParams.get('checks'), '[{"field_api_code":"field_1"}]');
});

test('buildUrl: throws on a missing path parameter', () => {
  assert.throws(() => buildUrl(base, byName.get_form, {}), /form_token/);
});

test('bodyPayload: nested, flattened and wrapped request bodies', () => {
  assert.deepEqual(bodyPayload(byName.create_entry, { form_token: 'x', entry: { field_1: '张三' } }), {
    field_1: '张三'
  });
  assert.deepEqual(bodyPayload(byName.copy_form, { form_token: 'x', name: '副本', folder_token: undefined }), {
    name: '副本'
  });
  assert.deepEqual(bodyPayload(byName.edit_field_rules, { form_token: 'x', remove: [0] }), {
    field_rules: { remove: [0] }
  });
  assert.equal(bodyPayload(byName.list_forms, { limit: 1 }), undefined);
});

test('buildBody: JSON request body', () => {
  const { body, contentType } = buildBody(byName.create_entry, { form_token: 'x', entry: { field_1: '张三' } });
  assert.equal(contentType, 'application/json');
  assert.equal(body, '{"field_1":"张三"}');
});

test('buildBody: multipart turns the base64 triple back into a file', async () => {
  const { body, contentType } = buildBody(byName.upload_form_image, {
    image_type: 'header',
    file_base64: 'data:image/png;base64,aGVsbG8=',
    file_name: 'a.png',
    content_type: 'image/png'
  });
  assert.equal(contentType, undefined);
  assert.ok(body instanceof FormData);
  const file = body.get('file') as File;
  assert.equal(file.name, 'a.png');
  assert.equal(file.type, 'image/png');
  assert.equal(await file.text(), 'hello');
  assert.equal(body.get('image_type'), 'header');
});

test('JinshujuApi.call: sends the credential, parses JSON, reads rate-limit and warning headers; refreshes once on 401', async () => {
  const seen: { url: string; auth: string | null }[] = [];
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls++;
    seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
    if (calls === 1) return new Response('{"error":"invalid_token"}', { status: 401 });
    return new Response('{"total":1,"count":1,"data":[],"next":null}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Input-Warnings': 'limit: too big',
        'X-RateLimit-Remaining': '9'
      }
    });
  };
  let token = 'old';
  const credential = {
    token: async () => token,
    invalidate: async () => {
      token = 'new';
      return true;
    },
    describe: () => 'test'
  };
  const api = new JinshujuApi({ baseUrl: base, fetch: fetchImpl });
  const res = await api.call(byName.list_forms, { limit: 1 }, credential);
  assert.equal(calls, 2);
  assert.equal(seen[0].auth, 'Bearer old');
  assert.equal(seen[1].auth, 'Bearer new');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { total: 1, count: 1, data: [], next: null });
  assert.equal(res.warnings, 'limit: too big');
  assert.equal(res.rateLimit?.remaining, '9');
});

test('JinshujuApi.call: a network failure throws TransportError', async () => {
  const api = new JinshujuApi({
    baseUrl: base,
    fetch: async () => {
      throw new Error('ECONNREFUSED');
    }
  });
  await assert.rejects(api.call(byName.list_forms, {}, new StaticCredential('t')), TransportError);
});
