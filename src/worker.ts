/**
 * Cloudflare Workers entry (an optional deployment). No Durable Objects / KV: the server is fully stateless.
 * With SENTRY_DSN set, exceptions go to Sentry (the SDK reads SENTRY_DSN / SENTRY_ENVIRONMENT from env itself); without it,
 * nothing is sent.
 */
import { withSentry, type CloudflareOptions } from '@sentry/cloudflare';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { VERSION } from './version.js';

type Env = Record<string, string | undefined>;
let app: ReturnType<typeof createApp> | undefined;

/** Errors only, no tracing; no request bodies / IPs / cookies: tool arguments and results hold user data, same policy as analytics.ts. */
export function sentryOptions(): CloudflareOptions {
  return {
    // Releases are organization-wide in Sentry, so the worker name keeps them apart from goldendata's; the name cannot contain /, so the npm package name won't do
    release: `jinshuju-mcp@${VERSION}`,
    dataCollection: { httpBodies: [], userInfo: false, cookies: false },
    // Events are sent from the server, so the IP Sentry infers from the connection is this service's, not the user's; the javascript platform infers it by default, so turn it off explicitly
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
