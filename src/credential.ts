/**
 * 凭证来源的接口与最简实现。
 *
 * HTTP 模式：每个请求自带 Bearer，凭证就是那个字符串（StaticCredential）。
 * stdio 模式的本地凭证（~/.jinshuju/config.json，含 refresh）在 cli-credential.ts，
 * 它依赖 node:fs；这个文件不依赖任何 Node API，所以 Worker 包里不会带进 node: 模块。
 */

export interface Credential {
  /** 当前可用的 access token */
  token(): Promise<string>;
  /** API 回了 401：丢弃缓存 / 尝试续期。返回 true 表示拿到了新凭证，值得重试一次。 */
  invalidate(): Promise<boolean>;
  /** 给 auth status 一类的说明用 */
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
      '没有可用的金数据凭证。可以：设置环境变量 JINSHUJU_ACCESS_TOKEN=<个人或企业 Access Token>；' +
        '或先用 `npx @jinshuju/cli auth login` 登录（本服务复用 ~/.jinshuju/config.json）。'
    );
    this.name = 'MissingCredentialError';
  }
}
