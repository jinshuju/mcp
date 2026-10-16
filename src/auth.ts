/**
 * Authentication in HTTP mode: this service is only an OAuth Resource Server.
 *
 * - The authorization server is account.jinshuju.net (dynamic registration / PKCE / refresh supported); this service
 *   issues no tokens;
 * - the request's Bearer (an OAuth token or a personal / account access token) goes to API v1 as is;
 * - the API decides whether a token is valid: one light call (GET /me) checks it, and the result is cached by token
 *   hash for a while, so every tool call does not spend an extra API request;
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
  maxEntries?: number;
  now?: () => number;
}

/** Token hash: the key of the verification cache, and the source of the analytics session id. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class TokenVerifier {
  private readonly cache = new Map<string, { info: AuthInfo; until: number }>();
  private readonly now: () => number;
  constructor(private readonly options: VerifierOptions) {
    this.now = options.now ?? Date.now;
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
      extra: me ? { userId: me.id, userName: me.name } : undefined
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
}

/** The Jinshuju user id in AuthInfo (the id from GET /me), undefined when no user was identified; analytics and Sentry both identify the user by it. */
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
