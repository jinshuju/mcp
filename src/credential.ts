/**
 * The credential source interface and its simplest implementation.
 *
 * HTTP mode: every request brings its own Bearer, and the credential is that string (StaticCredential).
 * The local credential for stdio mode (~/.jinshuju/config.json, with refresh) lives in cli-credential.ts,
 * which depends on node:fs; this file uses no Node API, so the Worker bundle pulls in no node: modules.
 */

export interface Credential {
  /** The access token currently usable */
  token(): Promise<string>;
  /** The API answered 401: drop the cache / try to renew. Returns true when a new credential was obtained and one retry is worthwhile. */
  invalidate(): Promise<boolean>;
  /** For descriptions such as auth status */
  describe(): string;
}

export class StaticCredential implements Credential {
  constructor(
    private readonly value: string,
    private readonly source = 'bearer'
  ) {}
  async token() {
    return this.value;
  }
  async invalidate() {
    return false;
  }
  describe() {
    return `access token (${this.source})`;
  }
}

export class MissingCredentialError extends Error {
  constructor() {
    super(
      'No Jinshuju credential available. Set JINSHUJU_ACCESS_TOKEN=<personal or account access token>, ' +
        'or log in first with `npx @jinshuju/cli auth login` (this server reuses ~/.jinshuju/config.json).'
    );
    this.name = 'MissingCredentialError';
  }
}
