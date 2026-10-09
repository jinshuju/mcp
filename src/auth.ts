/**
 * HTTP 模式的鉴权：本服务只是 OAuth 的 Resource Server。
 *
 * - 授权服务器是 account.jinshuju.net（已支持动态注册 / PKCE / refresh），本服务不签发任何令牌；
 * - 请求里的 Bearer（OAuth 令牌或个人 / 企业 Access Token）原样转给 API v1；
 * - 令牌是否有效由 API 说了算：用一次轻量调用（GET /me）确认，结果按令牌哈希缓存一段时间，
 *   避免每个工具调用都多花一次 API 配额；
 * - 没带 / 无效令牌时回 401 + WWW-Authenticate: Bearer resource_metadata=...，客户端据此走 OAuth。
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

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class TokenVerifier {
  private readonly cache = new Map<string, { info: AuthInfo; until: number }>();
  private readonly now: () => number;
  constructor(private readonly options: VerifierOptions) {
    this.now = options.now ?? Date.now;
  }

  /** 有效返回 AuthInfo，无效返回 undefined。网络故障视为无效但不缓存。 */
  async verify(token: string): Promise<AuthInfo | undefined> {
    const key = await sha256(token);
    const hit = this.cache.get(key);
    if (hit && hit.until > this.now()) return hit.info;
    this.cache.delete(key);
    const res = await this.options.api.raw('GET', '/me', token);
    // 401 = 令牌本身不被接受；其它状态（200 / 402 / 403 scope 不足 …）都说明令牌有效，只是能做的事不同。
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

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  const match = header && /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

export function challenge(resourceMetadataUrl: string, message: string): Response {
  return bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, message), { resourceMetadataUrl });
}

/** 从授权服务器拉 RFC 8414 元数据，失败时用内置的已知值。 */
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
    // 下面用内置值
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
