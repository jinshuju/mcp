#!/usr/bin/env node
/**
 * 本地 stdio 入口：`claude mcp add jinshuju -- npx -y @jinshuju/mcp`。
 * 凭证来自 JINSHUJU_ACCESS_TOKEN，或 @jinshuju/cli 登录后的 ~/.jinshuju/config.json。
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { configFromEnv } from './config.js';
import { MissingCredentialError, resolveCredential } from './credential.js';
import { buildServer } from './server.js';
import { VERSION } from './version.js';

if (process.argv.includes('--version') || process.argv.includes('-V')) {
  console.log(VERSION);
  process.exit(0);
}

try {
  const credential = await resolveCredential();
  const config = configFromEnv();
  console.error(`jinshuju-mcp ${VERSION}: ${credential.describe()}`);
  serveStdio(() => buildServer({ credential, config }));
} catch (error) {
  if (error instanceof MissingCredentialError) {
    console.error(error.message);
    process.exit(3);
  }
  throw error;
}
