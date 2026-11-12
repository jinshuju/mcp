// scripts/release.mjs writes this: a release sets it with package.json, a deploy moves only its patch, so package.json names the
// version on npm and this the one deployed. The runtime does not read package.json because Workers has no file system.
export const VERSION = '0.9.4'; // x-release-version
export const SERVER_NAME = 'jinshuju';
export const SERVER_TITLE = 'Jinshuju MCP Server';
