/**
 * Authentication in HTTP mode: this service is only an OAuth Resource Server.
 *
 * - The authorization server is account.jinshuju.net (dynamic registration / PKCE / refresh supported); this service
 *   issues no tokens;
 * - the request's Bearer (an OAuth token or a personal / account access token) goes to API v1 as is;
 * - the API decides whether a token is valid: one light call (GET /me) checks it, and the result is cached by token
 *   hash for a while, so every tool call does not spend an extra API request;
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

export interface VerifierOptions {
  api: JinshujuApi;
  cacheTtlMs: number;
  /** OAuth authorization server (issuer). When set, a valid token GET /me does not name is looked up at its token info. */
  authServer?: string;
  /** The fetch used for the token info lookup; the global fetch by default */
  fetch?: typeof fetch;
  maxEntries?: number;
  now?: () => number;
}

/** Time limit of the token info lookup: it only names the user, so a slow authorization server must not hold up the request for long. */
const TOKEN_INFO_TIMEOUT_MS = 5_000;

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

  /** Returns AuthInfo when valid, undefined when not. A network failure counts as invalid but is not cached. */
  async verify(token: string): Promise<AuthInfo | undefined> {
    const key = await sha256(token);
    const hit = this.cache.get(key);
    if (hit && hit.until > this.now()) return hit.info;
    this.cache.delete(key);
    const res = await this.options.api.raw('GET', '/me', token);
    // 401 = the token itself is refused; any other status (200 / 402 / 403 for insufficient scope …) means the token is valid and only what it may do differs.
    if (res.status === 401) return undefined;
    const me = (res.status === 200 ? res.json : undefined) as { id?: unknown; name?: unknown } | undefined;
    const info: AuthInfo = {
      token,
      clientId: 'jinshuju',
      scopes: [],
      extra: me ? { userId: me.id, userName: me.name } : await this.tokenOwner(token)
    };
    if (this.cache.size >= (this.options.maxEntries ?? 2000)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { info, until: this.now() + this.options.cacheTtlMs });
    return info;
  }

  async forget(token: string): Promise<void> {
    this.cache.delete(await sha256(token));
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
