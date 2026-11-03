/**
 * Authentication in HTTP mode: this service is only an OAuth Resource Server.
 *
 * - The authorization server is account.jinshuju.net (dynamic registration / PKCE / refresh supported); this service
 *   issues no tokens;
 * - the request's Bearer (an OAuth token or a personal / account access token) goes to API v1 as is;
 * - the API decides whether a token is valid: one light call (GET /me) checks it, and the result is cached by token
 *   hash, so every request does not spend an extra API request. The cache has two levels: this isolate's own map
 *   (5 minutes), and, when the deployment binds one, a KV namespace every instance shares (1 hour). A platform spreads one
 *   client's requests over many isolates, so without the shared level nearly every request misses;
 * - GET /me also names the user. An OAuth token without the `users` scope gets 403 there, so the user id then comes from
 *   the authorization server's token info, which answers whatever the token's scopes;
 * - with no token or an invalid one, answers 401 + WWW-Authenticate: Bearer resource_metadata=..., and the client
 *   goes through OAuth from there.
 */
import {
  bearerAuthChallengeResponse,
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthMetadata
} from '@modelcontextprotocol/server';
import type { JinshujuApi } from './api.js';

/** The calls of a Workers KV namespace the verifier uses; Cloudflare KV and WDL KV both have them. */
export interface SharedTokenCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface VerifierOptions {
  api: JinshujuApi;
  /** A cache every instance shares, asked when this isolate's own cache misses */
  shared?: SharedTokenCache;
  /** OAuth authorization server (issuer). When set, a valid token GET /me does not name is looked up at its token info. */
  authServer?: string;
  /** The fetch used for the token info lookup; the global fetch by default */
  fetch?: typeof fetch;
  maxEntries?: number;
  now?: () => number;
}

/** Time limit of the token info lookup: it only names the user, so a slow authorization server must not hold up the request for long. */
const TOKEN_INFO_TIMEOUT_MS = 5_000;

/**
 * How long a verification stays in this isolate's own memory. Shorter than the shared entry, so a token forgotten on
 * another isolate (the API refused it there) is verified again here within minutes.
 */
const MEMORY_TTL_MS = 5 * 60_000;

/**
 * How long a verification stays in the shared cache. OAuth access tokens live about two hours, so a longer entry would
 * mostly outlive its token; a revoked token passes handshakes and tools/list for at most this long (tool calls are
 * checked by the API, and a 401 there forgets it).
 */
const SHARED_TTL_MS = 60 * 60_000;

/** Key prefix in the shared cache, followed by the token's SHA-256 (never the token itself). */
const SHARED_KEY_PREFIX = 'auth:';

/**
 * A shared cache entry: the user id (absent when no user was identified) and when the entry ends. Only what a request
 * needs is stored; the user's name, which nothing reads, stays out.
 */
interface SharedEntry {
  userId?: unknown;
  until: number;
}

/** Token hash: the key of the verification cache, and the source of the analytics session id. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class TokenVerifier {
  private readonly cache = new Map<string, { info: AuthInfo; until: number }>();
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: VerifierOptions) {
    this.now = options.now ?? Date.now;
    // Don't store the global fetch as is: called as a method, its `this` is not the global object, and workerd throws Illegal invocation.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * Returns AuthInfo when valid, undefined when not. A network failure of the API counts as invalid but is not cached;
   * the shared cache failing only costs the API request it would have saved.
   */
  async verify(token: string): Promise<AuthInfo | undefined> {
    const key = await sha256(token);
    const hit = this.cache.get(key);
    if (hit && hit.until > this.now()) return hit.info;
    this.cache.delete(key);
    const shared = await this.readShared(key);
    if (shared) {
      const info = authInfo(
        token,
        shared.userId === undefined || shared.userId === null ? undefined : { userId: shared.userId }
      );
      // Never longer than the shared entry: a token forgotten elsewhere must not live on here past it
      this.remember(key, info, Math.min(this.now() + MEMORY_TTL_MS, shared.until));
      return info;
    }
    const res = await this.options.api.raw('GET', '/me', token);
    // 401 = the token itself is refused; any other status (200 / 402 / 403 for insufficient scope …) means the token is valid and only what it may do differs.
    if (res.status === 401) return undefined;
    const me = (res.status === 200 ? res.json : undefined) as { id?: unknown; name?: unknown } | undefined;
    const info = authInfo(token, me ? { userId: me.id, userName: me.name } : await this.tokenOwner(token));
    this.remember(key, info, this.now() + MEMORY_TTL_MS);
    await this.writeShared(key, info);
    return info;
  }

  /** The API refused a token verified earlier (it expired or was revoked): the next request verifies it again, on any instance. */
  async forget(token: string): Promise<void> {
    const key = await sha256(token);
    this.cache.delete(key);
    const shared = this.options.shared;
    if (!shared) return;
    try {
      await shared.delete(SHARED_KEY_PREFIX + key);
    } catch (error) {
      console.warn('shared token cache delete failed:', error);
    }
  }

  private remember(key: string, info: AuthInfo, until: number): void {
    if (this.cache.size >= (this.options.maxEntries ?? 2000)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { info, until });
  }

  /** The shared entry for this token hash, or undefined when there is none, it has ended, or the store fails. */
  private async readShared(key: string): Promise<SharedEntry | undefined> {
    const shared = this.options.shared;
    if (!shared) return undefined;
    let raw: string | null;
    try {
      raw = await shared.get(SHARED_KEY_PREFIX + key);
    } catch (error) {
      console.warn('shared token cache read failed:', error);
      return undefined;
    }
    if (!raw) return undefined;
    try {
      const entry = JSON.parse(raw) as Partial<SharedEntry> | null;
      // The store's own expiry is coarse (whole seconds, at least a minute); `until` is exact.
      return typeof entry?.until === 'number' && entry.until > this.now() ? (entry as SharedEntry) : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeShared(key: string, info: AuthInfo): Promise<void> {
    const shared = this.options.shared;
    if (!shared) return;
    const entry: SharedEntry = { userId: info.extra?.userId, until: this.now() + SHARED_TTL_MS };
    try {
      await shared.put(SHARED_KEY_PREFIX + key, JSON.stringify(entry), { expirationTtl: SHARED_TTL_MS / 1000 });
    } catch (error) {
      console.warn('shared token cache write failed:', error);
    }
  }

  /**
   * The user behind an OAuth token, from the authorization server's token info (Doorkeeper's GET /oauth/token/info):
   * it answers for any scope, and its resource_owner_id is the id GET /me returns. It gives no name. Personal and
   * account tokens are not OAuth tokens and get 401 there. Best effort: on any failure the user stays unnamed.
   */
  private async tokenOwner(token: string): Promise<{ userId: unknown } | undefined> {
    if (!this.options.authServer) return undefined;
    try {
      const res = await this.fetchImpl(`${this.options.authServer.replace(/\/$/, '')}/oauth/token/info`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TOKEN_INFO_TIMEOUT_MS)
      });
      if (res.status !== 200) return undefined;
      const owner = ((await res.json()) as { resource_owner_id?: unknown }).resource_owner_id;
      return owner === undefined || owner === null || owner === '' ? undefined : { userId: owner };
    } catch (error) {
      console.warn('token info lookup failed:', error);
      return undefined;
    }
  }
}

function authInfo(token: string, extra: Record<string, unknown> | undefined): AuthInfo {
  return { token, clientId: 'jinshuju', scopes: [], extra };
}

/** The Jinshuju user id in AuthInfo (from GET /me or the token info), undefined when no user was identified; analytics and Sentry both identify the user by it. */
export function userIdOf(authInfo: AuthInfo | undefined): string | undefined {
  const id = authInfo?.extra?.userId;
  return id === undefined || id === null || id === '' ? undefined : String(id);
}

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  const match = header && /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

export function challenge(resourceMetadataUrl: string, message: string): Response {
  return bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, message), { resourceMetadataUrl });
}

/** Fetches RFC 8414 metadata from the authorization server, falling back to built-in known values. */
export async function loadAuthServerMetadata(
  authServer: string,
  fetchImpl: typeof fetch = fetch
): Promise<OAuthMetadata> {
  try {
    const res = await fetchImpl(`${authServer}/.well-known/oauth-authorization-server`, {
      headers: { Accept: 'application/json' }
    });
    if (res.ok) return (await res.json()) as OAuthMetadata;
  } catch {
    // fall through to the built-in values below
  }
  return {
    issuer: authServer,
    authorization_endpoint: `${authServer}/oauth/authorize`,
    token_endpoint: `${authServer}/oauth/token`,
    revocation_endpoint: `${authServer}/oauth/revoke`,
    registration_endpoint: `${authServer}/oauth/register`,
    scopes_supported: ['public', 'profile', 'forms', 'read_entries', 'write_entries', 'form_setting', 'users'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256']
  };
}
