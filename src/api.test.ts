import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUrl, buildBody, bodyPayload, JinshujuApi, TransportError } from './api.js';
import { StaticCredential } from './credential.js';
import { TOOLS } from './tools.js';
import type { ToolSpec } from './types.js';

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t])) as Record<string, ToolSpec>;
const base = 'https://api.test/api/v1';

test('buildUrl：路径参数编码、query 省略空值、数组按 name[] 序列化', () => {
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
    params: [{ name: 'tags', in: 'query', required: false, array: true }]
  };
  const u2 = buildUrl(base, arrayTool, { tags: ['a', 'b'] });
  assert.equal(u2.search, '?tags%5B%5D=a&tags%5B%5D=b');
});

test('buildUrl：缺少路径参数时报错', () => {
  assert.throws(() => buildUrl(base, byName.get_form, {}), /form_token/);
});

test('bodyPayload：嵌套 / flatten / wrap 三种请求体', () => {
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

test('buildBody：JSON 请求体', () => {
  const { body, contentType } = buildBody(byName.create_entry, { form_token: 'x', entry: { field_1: '张三' } });
  assert.equal(contentType, 'application/json');
  assert.equal(body, '{"field_1":"张三"}');
});

test('buildBody：multipart 把 base64 三元组还原成文件', async () => {
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

test('JinshujuApi.call：带凭证、解析 JSON、读取限流与警告头；401 时续期一次', async () => {
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

test('JinshujuApi.call：网络失败抛 TransportError', async () => {
  const api = new JinshujuApi({
    baseUrl: base,
    fetch: async () => {
      throw new Error('ECONNREFUSED');
    }
  });
  await assert.rejects(api.call(byName.list_forms, {}, new StaticCredential('t')), TransportError);
});
