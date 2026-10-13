/**
 * 运行配置。HTTP 部署从环境变量（Node）或 Workers 的 env 读；stdio 只用其中与 API 相关的部分。
 */
export interface Config {
  /** API v1 地址，缺省 https://jinshuju.net/api/v1 */
  apiBaseUrl: string;
  /** OAuth 授权服务器（issuer），缺省 https://account.jinshuju.net */
  authServer: string;
  /**
   * 本服务对外地址，可多个（如自定义域名 https://mcp.jinshuju.net 与平台默认的带前缀地址 https://host/jinshuju-mcp）。
   * 按请求的 Host 选用其一，没有匹配的用第一个；为空则按每个请求的 X-Forwarded-* / Host 推断。
   */
  publicUrls: string[];
  /** 单次工具结果最多返回的字符数，超过则截断并提示缩小范围 */
  maxResultChars: number;
  /** HTTP 模式下令牌校验结果的缓存时长（毫秒） */
  tokenCacheTtlMs: number;
  /** 调用 API 的超时（毫秒） */
  timeoutMs: number;
  /** PostHog 项目 token（phc_…），HTTP 模式上报 MCP analytics；为空则不上报 */
  posthogApiKey?: string;
  /** PostHog 上报地址，缺省 https://us.i.posthog.com */
  posthogHost: string;
  /** 是否采集模型写的调用意图（每个工具的 context 参数 → $mcp_intent），缺省开 */
  collectIntent: boolean;
}

export const DEFAULTS: Config = {
  apiBaseUrl: 'https://jinshuju.net/api/v1',
  authServer: 'https://account.jinshuju.net',
  publicUrls: [],
  maxResultChars: 120_000,
  tokenCacheTtlMs: 5 * 60_000,
  timeoutMs: 60_000,
  posthogHost: 'https://us.i.posthog.com',
  collectIntent: true
};

type EnvLike = Record<string, string | undefined>;

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  const v = (value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/** JINSHUJU_MCP_PUBLIC_URL：逗号分隔多个地址，去掉尾部斜杠与空项。 */
export function publicUrlsFromEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((u) => u.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/** 从环境变量读配置；键名统一带 JINSHUJU_ 前缀，和 @jinshuju/cli 一致。 */
export function configFromEnv(env: EnvLike = process.env): Config {
  return {
    apiBaseUrl: (env.JINSHUJU_API_BASE_URL ?? DEFAULTS.apiBaseUrl).replace(/\/$/, ''),
    authServer: (env.JINSHUJU_AUTH_HOST ?? DEFAULTS.authServer).replace(/\/$/, ''),
    publicUrls: publicUrlsFromEnv(env.JINSHUJU_MCP_PUBLIC_URL),
    maxResultChars: int(env.JINSHUJU_MCP_MAX_RESULT_CHARS, DEFAULTS.maxResultChars),
    tokenCacheTtlMs: int(env.JINSHUJU_MCP_TOKEN_CACHE_TTL_MS, DEFAULTS.tokenCacheTtlMs),
    timeoutMs: int(env.JINSHUJU_MCP_TIMEOUT_MS, DEFAULTS.timeoutMs),
    posthogApiKey: env.POSTHOG_API_KEY?.trim() || undefined,
    posthogHost: (env.POSTHOG_HOST?.trim() || DEFAULTS.posthogHost).replace(/\/$/, ''),
    collectIntent: bool(env.JINSHUJU_MCP_COLLECT_INTENT, DEFAULTS.collectIntent)
  };
}
