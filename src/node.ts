#!/usr/bin/env node
/** Node 进程入口：官方部署（Docker / k8s）用。 */
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

// posthog-node 定时批量发送；进程退出前把队列里的事件发完。
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
