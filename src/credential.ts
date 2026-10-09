/**
 * 凭证来源。
 *
 * HTTP 模式：每个请求自带 Bearer，凭证就是那个字符串（StaticCredential）。
 * stdio 模式：按 @jinshuju/cli 的约定取：JINSHUJU_ACCESS_TOKEN 环境变量优先，
 * 其次 ~/.jinshuju/config.json 里 `jinshuju auth login` 存下的凭证（access token 或 OAuth 会话，
 * 会话过期时用 refresh_token 续期并写回，mode 600）。两个工具共用一份登录。
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Credential {
  /** 当前可用的 access token */
  token(): Promise<string>;
  /** API 回了 401：丢弃缓存 / 尝试续期。返回 true 表示拿到了新凭证，值得重试一次。 */
  invalidate(): Promise<boolean>;
  /** 给 auth status 一类的说明用 */
  describe(): string;
}

export class StaticCredential implements Credential {
  constructor(
    private readonly value: string,
    private readonly source = 'bearer'
  ) {}
  async token() {
    return this.value;
  }
  async invalidate() {
    return false;
  }
  describe() {
    return `access token (${this.source})`;
  }
}

export class MissingCredentialError extends Error {
  constructor() {
    super(
      '没有可用的金数据凭证。可以：设置环境变量 JINSHUJU_ACCESS_TOKEN=<个人或企业 Access Token>；' +
        '或先用 `npx @jinshuju/cli auth login` 登录（本服务复用 ~/.jinshuju/config.json）。'
    );
    this.name = 'MissingCredentialError';
  }
}

// ---- ~/.jinshuju/config.json（与 @jinshuju/cli 共用） ----

interface OAuthSession {
  type: 'oauth';
  auth_host?: string;
  client_id?: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  scope?: string;
}
interface TokenCredential {
  type?: 'access_token';
  access_token: string;
}
interface CliConfig {
  auth?: OAuthSession | TokenCredential;
  access_token?: string;
  auth_host?: string;
  client_id?: string;
}

export const DEFAULT_CONFIG_PATH = join(homedir(), '.jinshuju', 'config.json');
const DEFAULT_CLIENT_ID = 'jinshuju_cli_public';

export class CliSessionCredential implements Credential {
  private config?: CliConfig;
  private refreshing?: Promise<boolean>;

  constructor(
    private readonly path = DEFAULT_CONFIG_PATH,
    private readonly authHost = 'https://account.jinshuju.net',
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  static async exists(path = DEFAULT_CONFIG_PATH): Promise<boolean> {
    try {
      await readFile(path, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  private async load(): Promise<CliConfig> {
    if (!this.config) this.config = JSON.parse(await readFile(this.path, 'utf8')) as CliConfig;
    return this.config;
  }

  private session(config: CliConfig): OAuthSession | undefined {
    const auth = config.auth;
    return auth && (auth as OAuthSession).type === 'oauth' ? (auth as OAuthSession) : undefined;
  }

  describe() {
    const session = this.config && this.session(this.config);
    return session ? `OAuth 会话（${this.path}）` : `access token（${this.path}）`;
  }

  async token(): Promise<string> {
    const config = await this.load();
    const session = this.session(config);
    if (session) {
      const expiresAt = session.expires_at ? Date.parse(session.expires_at) : Number.NaN;
      // 提前一分钟续期，避免请求路上过期
      if (Number.isFinite(expiresAt) && expiresAt - Date.now() < 60_000 && session.refresh_token) {
        await this.refresh();
      }
      return this.session(this.config!)!.access_token;
    }
    const token = (config.auth as TokenCredential | undefined)?.access_token ?? config.access_token;
    if (!token) throw new MissingCredentialError();
    return token;
  }

  async invalidate(): Promise<boolean> {
    const config = await this.load();
    if (!this.session(config)?.refresh_token) return false;
    return this.refresh();
  }

  private refresh(): Promise<boolean> {
    // 并发的工具调用共用同一次续期
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const config = await this.load();
    const session = this.session(config);
    if (!session?.refresh_token) return false;
    const host = session.auth_host ?? config.auth_host ?? this.authHost;
    const clientId = session.client_id ?? config.client_id ?? DEFAULT_CLIENT_ID;
    const res = await this.fetchImpl(new URL('/oauth/token', host), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refresh_token,
        client_id: clientId
      })
    });
    if (!res.ok) return false;
    const body = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    const next: OAuthSession = {
      ...session,
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? session.refresh_token,
      expires_at: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : session.expires_at,
      scope: body.scope ?? session.scope
    };
    this.config = { ...config, auth: next };
    await this.save(this.config);
    return true;
  }

  private async save(config: CliConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}

/** stdio 入口用：按优先级挑一个凭证来源。 */
export async function resolveCredential(env: Record<string, string | undefined> = process.env): Promise<Credential> {
  if (env.JINSHUJU_ACCESS_TOKEN) return new StaticCredential(env.JINSHUJU_ACCESS_TOKEN, 'env JINSHUJU_ACCESS_TOKEN');
  const path = env.JINSHUJU_CONFIG ?? DEFAULT_CONFIG_PATH;
  if (await CliSessionCredential.exists(path)) return new CliSessionCredential(path, env.JINSHUJU_AUTH_HOST);
  throw new MissingCredentialError();
}
