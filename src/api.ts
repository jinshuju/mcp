/**
 * Sends one API v1 request for an OperationSpec. It only decides how to send it: URL, query, body, multipart,
 * credential, timeout and response parsing. What to send comes from the generated operation table; how to report
 * the result is up to tools.ts.
 */
import type { Credential } from './credential.js';
import type { OperationSpec } from './types.js';

export interface ApiOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export interface ApiResponse {
  status: number;
  /** The parsed JSON; undefined for a non-JSON or empty response */
  json?: unknown;
  /** The raw text of a non-JSON response (truncated) */
  text?: string;
  /** Argument problems the server reports in report mode (X-API-Input-Warnings) */
  warnings?: string;
  retryAfter?: string;
  rateLimit?: { limit?: string; remaining?: string; reset?: string };
}

export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransportError';
  }
}

type Args = Record<string, unknown>;

export function buildUrl(baseUrl: string, op: OperationSpec, args: Args): URL {
  let path = op.path;
  for (const p of op.params) {
    if (p.in !== 'path') continue;
    const value = args[p.name];
    if (value === undefined || value === null || value === '') throw new Error(`Missing path parameter ${p.name}`);
    path = path.replace(`{${p.name}}`, encodeURIComponent(String(value).trim()));
  }
  const url = new URL(baseUrl.replace(/\/$/, '') + path);
  for (const p of op.params) {
    if (p.in !== 'query') continue;
    const value = args[p.name];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(`${p.name}[]`, scalar(item));
    } else {
      url.searchParams.set(p.name, scalar(value));
    }
  }
  return url;
}

function scalar(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function decodeBase64(data: string): Uint8Array {
  const raw = data.startsWith('data:') && data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  const bin = atob(raw.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** The request body: when flattened, every argument key except the path / query parameters; otherwise the value under body.param. */
export function bodyPayload(op: OperationSpec, args: Args): unknown {
  if (!op.body) return undefined;
  let payload: unknown;
  if (op.body.flatten) {
    const rest: Args = {};
    for (const [key, value] of Object.entries(args)) {
      if (!op.paramNames.includes(key) && value !== undefined) rest[key] = value;
    }
    payload = rest;
  } else {
    payload = args[op.body.param ?? 'body'];
  }
  if (payload === undefined) return undefined;
  return op.body.wrap ? { [op.body.wrap]: payload } : payload;
}

export function buildBody(op: OperationSpec, args: Args): { body?: BodyInit; contentType?: string } {
  const payload = bodyPayload(op, args);
  if (!op.body || payload === undefined) return {};
  if (op.body.contentType === 'application/json') {
    return { body: JSON.stringify(payload), contentType: 'application/json' };
  }
  const fields = payload as Record<string, unknown>;
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'file_base64' || key === 'file_name' || key === 'content_type') continue;
    if (value === undefined || value === null) continue;
    form.set(key, scalar(value));
  }
  if (typeof fields.file_base64 === 'string') {
    const bytes = decodeBase64(fields.file_base64);
    const type = typeof fields.content_type === 'string' ? fields.content_type : 'application/octet-stream';
    const name = typeof fields.file_name === 'string' ? fields.file_name : 'file';
    form.set('file', new Blob([bytes as BlobPart], { type }), name);
  }
  // fetch sets the multipart Content-Type (with its boundary) itself
  return { body: form };
}

export class JinshujuApi {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: ApiOptions) {
    // Don't store the global fetch as is: called as a method, its `this` is not the global object, and workerd / browsers throw Illegal invocation.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get baseUrl() {
    return this.options.baseUrl;
  }

  /** Sends the request; on 401, has the credential renew once and retries. */
  async call(op: OperationSpec, args: Args, credential: Credential): Promise<ApiResponse> {
    const first = await this.send(op, args, await credential.token());
    if (first.status !== 401) return first;
    if (!(await credential.invalidate())) return first;
    return this.send(op, args, await credential.token());
  }

  /** A raw request outside the operation table, for internal calls such as token verification. */
  async raw(method: string, path: string, token: string): Promise<ApiResponse> {
    return this.perform(method, new URL(this.options.baseUrl.replace(/\/$/, '') + path), token, {});
  }

  private async send(op: OperationSpec, args: Args, token: string): Promise<ApiResponse> {
    const url = buildUrl(this.options.baseUrl, op, args);
    return this.perform(op.method.toUpperCase(), url, token, buildBody(op, args));
  }

  private async perform(
    method: string,
    url: URL,
    token: string,
    { body, contentType }: { body?: BodyInit; contentType?: string }
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': this.options.userAgent ?? 'jinshuju-mcp'
    };
    if (contentType) headers['Content-Type'] = contentType;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: controller.signal });
    } catch (error) {
      const reason = controller.signal.aborted ? 'Request timed out' : 'Could not reach the Jinshuju API';
      const detail = error instanceof Error ? `: ${error.message}` : '';
      throw new TransportError(`${reason} (${method} ${url.pathname})${detail}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    const out: ApiResponse = { status: res.status };
    const warnings = res.headers.get('x-api-input-warnings');
    if (warnings) out.warnings = warnings;
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) out.retryAfter = retryAfter;
    const rateLimit = {
      limit: res.headers.get('x-ratelimit-limit') ?? undefined,
      remaining: res.headers.get('x-ratelimit-remaining') ?? undefined,
      reset: res.headers.get('x-ratelimit-reset') ?? undefined
    };
    if (rateLimit.limit || rateLimit.remaining || rateLimit.reset) out.rateLimit = rateLimit;
    if (!text) return out;
    try {
      out.json = JSON.parse(text);
    } catch {
      out.text = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
    }
    return out;
  }
}
