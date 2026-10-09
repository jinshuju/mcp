/**
 * 运行配置。HTTP 部署从环境变量（Node）或 Workers 的 env 读；stdio 只用其中与 API 相关的部分。
 */
export interface Config {
  /** API v1 地址，缺省 https://jinshuju.net/api/v1 */
  apiBaseUrl: string;
  /** OAuth 授权服务器（issuer），缺省 https://account.jinshuju.net */
  authServer: string;
  /** 本服务对外地址（如 https://mcp.jinshuju.net）。留空则按每个请求的 Host 推断。 */
  publicUrl?: string;
  /** 单次工具结果最多返回的字符数，超过则截断并提示缩小范围 */
  maxResultChars: number;
  /** HTTP 模式下令牌校验结果的缓存时长（毫秒） */
  tokenCacheTtlMs: number;
  /** 调用 API 的超时（毫秒） */
  timeoutMs: number;
}

export const DEFAULTS: Config = {
  apiBaseUrl: 'https://jinshuju.net/api/v1',
  authServer: 'https://account.jinshuju.net',
  publicUrl: undefined,
  maxResultChars: 120_000,
  tokenCacheTtlMs: 5 * 60_000,
  timeoutMs: 60_000
};

type EnvLike = Record<string, string | undefined>;

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 从环境变量读配置；键名统一带 JINSHUJU_ 前缀，和 @jinshuju/cli 一致。 */
export function configFromEnv(env: EnvLike = process.env): Config {
  return {
    apiBaseUrl: (env.JINSHUJU_API_BASE_URL ?? DEFAULTS.apiBaseUrl).replace(/\/$/, ''),
    authServer: (env.JINSHUJU_AUTH_HOST ?? DEFAULTS.authServer).replace(/\/$/, ''),
    publicUrl: env.JINSHUJU_MCP_PUBLIC_URL?.replace(/\/$/, '') || undefined,
    maxResultChars: int(env.JINSHUJU_MCP_MAX_RESULT_CHARS, DEFAULTS.maxResultChars),
    tokenCacheTtlMs: int(env.JINSHUJU_MCP_TOKEN_CACHE_TTL_MS, DEFAULTS.tokenCacheTtlMs),
    timeoutMs: int(env.JINSHUJU_MCP_TIMEOUT_MS, DEFAULTS.timeoutMs)
  };
}
