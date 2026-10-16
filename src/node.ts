#!/usr/bin/env node
/** Node process entry, used by the official deployment (Docker / k8s). */
import { serve } from '@hono/node-server';
import { analyticsFromConfig } from './analytics.js';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { VERSION } from './version.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
const config = configFromEnv();
const analytics = analyticsFromConfig(config);
const app = createApp({ config, analytics });

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.error(`jinshuju-mcp ${VERSION} listening on http://${info.address}:${info.port}/mcp`);
});

// posthog-node sends in timed batches; flush the queued events before the process exits.
if (analytics) {
  const stop = () => {
    analytics
      .shutdown()
      .catch((error) => console.error('posthog shutdown failed:', error))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
