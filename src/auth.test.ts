import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JinshujuApi } from './api.js';
import { sha256, TokenVerifier, userIdOf, type SharedTokenCache } from './auth.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const FORBIDDEN = () =>
  new Response('{"error_description":"OAuth token scope is insufficient"}', { status: 403, headers: JSON_HEADERS });
const HOUR = 3_600_000;

/** A KV namespace in memory that expires values as Workers KV does: `expirationTtl` seconds after the put. */
function kv(now: () => number = Date.now) {
  const values = new Map<string, { value: string; expires: number }>();
  const ttls: number[] = [];
  const store: SharedTokenCache = {
    async get(key) {
      const entry = values.get(key);
      return entry && entry.expires > now() ? entry.value : null;
    },
    async put(key, value, { expirationTtl }) {
      ttls.push(expirationTtl);
      values.set(key, { value, expires: now() + expirationTtl * 1000 });
    },
    async delete(key) {
      values.delete(key);
    }
  };
  return { store, values, ttls };
}

/** A verifier over a fake API and authorization server; records every request it makes. */
function verifier(
  options: {
    me?: () => Response;
    tokenInfo?: () => Response;
    /** Shared cache; two verifiers given the same one stand for two isolates of one deployment */
    shared?: SharedTokenCache;
    now?: () => number;
  } = {}
) {
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
    shared: options.shared,
    authServer: 'https://account.test/',
    fetch: fetchImpl,
    now: options.now
  });
  return { v, calls };
}

/** Runs fn with console.warn silenced, returning what it warned. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: unknown[][] }> {
  const warn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = warn;
  }
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
    fetch: fetchImpl
  });
  const info = await v.verify('forms-only');
  assert.ok(info);
  assert.equal(userIdOf(info), undefined);
  assert.deepEqual(calls, ['https://api.test/api/v1/me']);
});

test('another isolate takes the verification from the shared cache and asks the API nothing', async () => {
  const { store } = kv();
  const a = verifier({ shared: store });
  const b = verifier({ shared: store });
  await a.v.verify('good');
  const info = await b.v.verify('good');
  assert.equal(info?.token, 'good');
  assert.equal(userIdOf(info), 'u1');
  assert.deepEqual(b.calls, []);
});

test('the shared entry is keyed by the token hash and holds the user id, never the token or the name', async () => {
  const { store, values, ttls } = kv();
  await verifier({ shared: store }).v.verify('good');
  assert.deepEqual([...values.keys()], [`auth:${await sha256('good')}`]);
  const value = [...values.values()][0].value;
  assert.equal(JSON.parse(value).userId, 'u1');
  assert.doesNotMatch(value, /good|周/);
  assert.deepEqual(ttls, [3600], 'the store expires it after the shared TTL, in seconds');
});

test('a token without the users scope: another isolate asks neither GET /me nor the token info', async () => {
  const { store } = kv();
  const tokenInfo = () => new Response('{"resource_owner_id":"u2"}', { headers: JSON_HEADERS });
  const a = verifier({ shared: store, me: FORBIDDEN, tokenInfo });
  const b = verifier({ shared: store, me: FORBIDDEN, tokenInfo });
  await a.v.verify('forms-only');
  assert.equal(a.calls.length, 2);
  assert.equal(userIdOf(await b.v.verify('forms-only')), 'u2');
  assert.deepEqual(b.calls, []);
});

test('a token no user is known for is shared too, and stays anonymous', async () => {
  const { store } = kv();
  await verifier({ shared: store, me: FORBIDDEN }).v.verify('personal');
  const b = verifier({ shared: store, me: FORBIDDEN });
  const info = await b.v.verify('personal');
  assert.ok(info, 'the token is still valid');
  assert.equal(userIdOf(info), undefined);
  assert.deepEqual(b.calls, []);
});

test('a refused token is not shared', async () => {
  const { store, values } = kv();
  const refused = () => new Response('{"error":"invalid_token"}', { status: 401 });
  assert.equal(await verifier({ shared: store, me: refused }).v.verify('bad'), undefined);
  assert.equal(values.size, 0);
  const b = verifier({ shared: store, me: refused });
  assert.equal(await b.v.verify('bad'), undefined);
  assert.equal(b.calls.length, 1);
});

test('forget removes the shared entry: every isolate verifies the token again', async () => {
  const { store } = kv();
  const a = verifier({ shared: store });
  await a.v.verify('good');
  await a.v.forget('good');
  const b = verifier({ shared: store });
  await b.v.verify('good');
  assert.equal(b.calls.length, 1);
});

test('a shared entry lasts its TTL, and the memory cache it fills ends with it', async () => {
  let t = 0;
  const now = () => t;
  const { store } = kv(now);
  await verifier({ shared: store, now }).v.verify('good');
  const b = verifier({ shared: store, now });
  t = HOUR - 30_000;
  await b.v.verify('good');
  assert.equal(b.calls.length, 0, 'still in the shared cache');
  // Within b's 5-minute memory TTL, but past the shared entry: b must not keep the token any longer than the shared cache
  t = HOUR + 1;
  await b.v.verify('good');
  assert.equal(b.calls.length, 1);
});

test('a shared entry past its end is ignored even while the store still returns it', async () => {
  let t = 0;
  const now = () => t;
  const { store, values } = kv(now);
  await verifier({ shared: store, now }).v.verify('good');
  // The store's own expiry is coarser than the entry's end; here it never expires at all
  const late: SharedTokenCache = { ...store, get: async (key) => values.get(key)?.value ?? null };
  t = HOUR + 1;
  const b = verifier({ shared: late, now });
  await b.v.verify('good');
  assert.equal(b.calls.length, 1);
});

test('the shared cache failing costs only the API request it would have saved', async () => {
  const broken: SharedTokenCache = {
    get: () => Promise.reject(new Error('KV read timed out')),
    put: () => Promise.reject(new Error('KV write failed')),
    delete: () => Promise.reject(new Error('KV delete failed'))
  };
  const { v, calls } = verifier({ shared: broken });
  const { result: info, warnings } = await quietly(async () => {
    const info = await v.verify('good');
    await v.forget('good');
    return info;
  });
  assert.equal(userIdOf(info), 'u1');
  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 3, 'read, write and delete each warn');
  assert.doesNotMatch(JSON.stringify(warnings.map((w) => String(w[1]))), /good/);
});

test('an unreadable shared entry is a miss', async () => {
  const { store, values } = kv();
  values.set(`auth:${await sha256('good')}`, { value: 'not json', expires: Number.MAX_SAFE_INTEGER });
  const { v, calls } = verifier({ shared: store });
  assert.equal(userIdOf(await v.verify('good')), 'u1');
  assert.equal(calls.length, 1);
});
