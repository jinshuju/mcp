/**
 * Runtime configuration. The HTTP deployment reads it from environment variables (Node) or the Workers env; stdio uses only the API-related part.
 */
export interface Config {
  /** API v1 base URL, https://jinshuju.net/api/v1 by default */
  apiBaseUrl: string;
  /** OAuth authorization server (issuer), https://account.jinshuju.net by default */
  authServer: string;
  /**
   * Public addresses of this service, possibly several (e.g. the custom domain https://mcp.jinshuju.net and the platform's
   * default prefixed address https://host/jinshuju-mcp). One is picked by the request's Host, falling back to the first;
   * when empty, each request's X-Forwarded-* / Host decides.
   */
  publicUrls: string[];
  /** Most characters one tool result returns; beyond it the result is truncated with a hint to narrow it */
  maxResultChars: number;
  /** How long token verification results are cached in HTTP mode (ms) */
  tokenCacheTtlMs: number;
  /** Timeout of API calls (ms) */
  timeoutMs: number;
  /** PostHog project token (phc_…) for MCP analytics in HTTP mode; nothing is reported when empty */
  posthogApiKey?: string;
  /** PostHog ingest host, https://us.i.posthog.com by default */
  posthogHost: string;
  /** Whether to collect the call intent the model writes (each tool's context argument → $mcp_intent); on by default */
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

/** JINSHUJU_MCP_PUBLIC_URL: several comma-separated addresses, with trailing slashes and empty items removed. */
export function publicUrlsFromEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((u) => u.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/** Reads the configuration from environment variables; keys carry the JINSHUJU_ prefix, as in @jinshuju/cli. */
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
