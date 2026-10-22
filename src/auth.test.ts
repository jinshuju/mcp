import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JinshujuApi } from './api.js';
import { TokenVerifier, userIdOf } from './auth.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const FORBIDDEN = () =>
  new Response('{"error_description":"OAuth token scope is insufficient"}', { status: 403, headers: JSON_HEADERS });

/** A verifier over a fake API and authorization server; records every request it makes. */
function verifier(options: { me?: () => Response; tokenInfo?: () => Response } = {}) {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    if (url === 'https://api.test/api/v1/me')
      return options.me?.() ?? new Response('{"id":"u1","name":"周"}', { headers: JSON_HEADERS });
    if (url === 'https://account.test/oauth/token/info')
      return options.tokenInfo?.() ?? new Response('{"error":"invalid_token"}', { status: 401 });
    return new Response('not found', { status: 404 });
  };
  const v = new TokenVerifier({
    api: new JinshujuApi({ baseUrl: 'https://api.test/api/v1', fetch: fetchImpl }),
    cacheTtlMs: 60_000,
    authServer: 'https://account.test/',
    fetch: fetchImpl
  });
  return { v, calls };
}

test('GET /me names the user: the token info is not asked', async () => {
  const { v, calls } = verifier();
  const info = await v.verify('good');
  assert.deepEqual(info?.extra, { userId: 'u1', userName: '周' });
  assert.deepEqual(
    calls.map((c) => c.url),
    ['https://api.test/api/v1/me']
  );
});

test('an OAuth token without the users scope: the user id comes from the token info, asked with the same token', async () => {
  const { v, calls } = verifier({
    me: FORBIDDEN,
    tokenInfo: () =>
      new Response('{"resource_owner_id":"u2","scope":["forms"],"expires_in":7200,"application":{"uid":"app"}}', {
        headers: JSON_HEADERS
      })
  });
  const info = await v.verify('forms-only');
  assert.equal(userIdOf(info), 'u2');
  assert.equal(info?.extra?.userName, undefined);
  assert.deepEqual(calls[1], { url: 'https://account.test/oauth/token/info', authorization: 'Bearer forms-only' });
  // Cached like any other result: the next request asks neither
  await v.verify('forms-only');
  assert.equal(calls.length, 2);
});

test('the token info does not know the token (a personal or account token): valid, but no user', async () => {
  const { v } = verifier({ me: FORBIDDEN });
  const info = await v.verify('personal');
  assert.ok(info, 'the token is still valid');
  assert.equal(userIdOf(info), undefined);
});

test('the authorization server is unreachable: valid, but no user', async () => {
  const { v } = verifier({
    me: FORBIDDEN,
    tokenInfo: () => {
      throw new TypeError('fetch failed');
    }
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const info = await v.verify('forms-only');
    assert.ok(info, 'the token is still valid');
    assert.equal(userIdOf(info), undefined);
  } finally {
    console.warn = warn;
  }
});

test('GET /me refuses the token: invalid, and the token info is not asked', async () => {
  const { v, calls } = verifier({ me: () => new Response('{"error":"invalid_token"}', { status: 401 }) });
  assert.equal(await v.verify('bad'), undefined);
  assert.equal(calls.length, 1);
});

test('without an authorization server, a token GET /me does not name stays anonymous', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return FORBIDDEN();
  };
  const v = new TokenVerifier({
    api: new JinshujuApi({ baseUrl: 'https://api.test/api/v1', fetch: fetchImpl }),
    cacheTtlMs: 60_000,
    fetch: fetchImpl
  });
  const info = await v.verify('forms-only');
  assert.ok(info);
  assert.equal(userIdOf(info), undefined);
  assert.deepEqual(calls, ['https://api.test/api/v1/me']);
});
