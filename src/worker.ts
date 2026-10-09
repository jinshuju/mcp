/** Cloudflare Workers 入口（可选部署方式）。无 Durable Objects / KV：服务器完全无状态。 */
import { createApp } from './app.js';
import { configFromEnv } from './config.js';

type Env = Record<string, string | undefined>;
let app: ReturnType<typeof createApp> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: unknown): Promise<Response> | Response {
    app ??= createApp({ config: configFromEnv(env) });
    return app.fetch(request, env, ctx as never);
  }
};
