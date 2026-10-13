/**
 * Cloudflare Workers 入口（可选部署方式）。无 Durable Objects / KV：服务器完全无状态。
 * 配了 SENTRY_DSN 就把异常报到 Sentry（SDK 自己从 env 读 SENTRY_DSN / SENTRY_ENVIRONMENT），没配时什么都不发。
 */
import { withSentry, type CloudflareOptions } from '@sentry/cloudflare';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { VERSION } from './version.js';

type Env = Record<string, string | undefined>;
let app: ReturnType<typeof createApp> | undefined;

/** 只要错误，不开 tracing；不采集请求体 / IP / cookie：工具入参和返回里有用户的数据，口径同 analytics.ts。 */
export function sentryOptions(): CloudflareOptions {
  return {
    // release 在 Sentry 里是组织级的，用 worker 名和 goldendata 的区分开；名字里不能有 /，npm 包名用不了
    release: `jinshuju-mcp@${VERSION}`,
    dataCollection: { httpBodies: [], userInfo: false, cookies: false },
    // 事件由服务端发出，Sentry 按连接推断的 IP 是本服务的，不是用户的；javascript 平台缺省会推断，明确关掉
    beforeSend(event) {
      event.sdk = { ...event.sdk, settings: { ...event.sdk?.settings, infer_ip: 'never' } };
      return event;
    }
  };
}

export default withSentry(sentryOptions, {
  fetch(request: Request, env: Env, ctx: unknown): Promise<Response> | Response {
    app ??= createApp({ config: configFromEnv(env) });
    return app.fetch(request, env, ctx as never);
  }
});
