#!/usr/bin/env node
/**
 * Local stdio entry: `claude mcp add jinshuju -- npx -y @jinshuju/mcp`.
 * The credential comes from JINSHUJU_ACCESS_TOKEN, or from ~/.jinshuju/config.json after logging in with @jinshuju/cli.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { configFromEnv } from './config.js';
import { resolveCredential } from './cli-credential.js';
import { MissingCredentialError } from './credential.js';
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
