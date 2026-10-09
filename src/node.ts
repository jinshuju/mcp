#!/usr/bin/env node
/** Node 进程入口：官方部署（Docker / k8s）用。 */
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { VERSION } from './version.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
const app = createApp({ config: configFromEnv() });

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.error(`jinshuju-mcp ${VERSION} listening on http://${info.address}:${info.port}/mcp`);
});
