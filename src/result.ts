/**
 * Turns an API response into a CallToolResult the model can read: compact JSON on success (truncated when needed),
 * and on failure the HTTP status + the server's error_description / errors[] + a line on what to do.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiResponse } from './api.js';
import type { ToolSpec } from './types.js';

function errorLines(res: ApiResponse): string[] {
  const lines: string[] = [];
  const body = res.json as Record<string, unknown> | undefined;
  const stated = body?.error_description ?? body?.message ?? body?.error;
  if (typeof stated === 'string' && stated.trim()) lines.push(stated.trim());
  const errors = body?.errors;
  if (Array.isArray(errors)) {
    for (const item of errors) {
      if (typeof item === 'string') lines.push(`- ${item}`);
      else if (item && typeof item === 'object') {
        const { pointer, message, code, index, reason } = item as Record<string, unknown>;
        const where = pointer ?? (index === undefined ? undefined : `row ${index}`);
        const what = message ?? reason ?? JSON.stringify(item);
        lines.push(`- ${where === undefined ? '' : `${where}: `}${what}${code ? ` (${code})` : ''}`);
      }
    }
  }
  if (!lines.length && res.text) lines.push(res.text);
  return lines;
}

function hint(status: number, res: ApiResponse): string {
  switch (status) {
    case 400:
      return 'Arguments or data failed validation: fix them as described above and retry.';
    case 401:
      return 'The credential is invalid or expired: re-authorize, or use another access token.';
    case 402:
      return 'The current plan does not include API v1.';
    case 403:
      return 'No permission, a quota is used up, or the OAuth scope is insufficient.';
    case 404:
      return 'The resource does not exist or this credential cannot access it (check the token / serial number).';
    case 415:
      return 'The request body must be JSON.';
    case 422:
      return 'Rejected; see the reasons above. A batch returns 422 only when every item failed.';
    case 429:
      return `Rate limit exceeded; retry ${res.retryAfter ? `in ${res.retryAfter} seconds` : 'later'}.`;
    default:
      return status >= 500 ? 'Jinshuju server error; retry later, and report it if it keeps happening.' : '';
  }
}

export function toToolResult(tool: ToolSpec, res: ApiResponse, maxResultChars: number): CallToolResult {
  const note = res.warnings ? `\n⚠ Server warnings about the arguments (X-API-Input-Warnings): ${res.warnings}` : '';
  if (res.status >= 200 && res.status < 300) {
    const payload = res.json;
    let text = payload === undefined ? (res.text ?? '') : JSON.stringify(payload);
    let truncated = false;
    if (text.length > maxResultChars) {
      truncated = true;
      text =
        `${text.slice(0, maxResultChars)}\n… (Result truncated: ${text.length} characters in all. ` +
        'Narrow it with fields / limit / filters / keyword, or page through it with next.)';
    }
    const result: CallToolResult = { content: [{ type: 'text', text: text + note }] };
    if (tool.outputSchema) {
      // A tool that declares an outputSchema must return structuredContent. When truncated, don't stuff the whole large result in again; return a small explanatory object.
      if (truncated) {
        result.structuredContent = { truncated: true, total_chars: JSON.stringify(payload).length };
      } else if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        result.structuredContent = payload as Record<string, unknown>;
      } else {
        result.structuredContent = { result: payload };
      }
    }
    return result;
  }
  const lines = [`HTTP ${res.status}: ${tool.name} failed.`, ...errorLines(res)];
  const h = hint(res.status, res);
  if (h) lines.push(h);
  return { isError: true, content: [{ type: 'text', text: lines.join('\n') + note }] };
}
