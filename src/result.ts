/**
 * 把 API 响应翻译成模型能读懂的 CallToolResult：成功给紧凑 JSON（必要时截断），
 * 失败给 HTTP 状态 + 服务端的 error_description / errors[] + 一句怎么办。
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
      return '参数或数据校验失败：按上面的说明修正后重试。';
    case 401:
      return '凭证无效或已过期：请重新授权 / 更换 Access Token。';
    case 402:
      return '当前套餐不包含 API v1 能力。';
    case 403:
      return '无权限、配额已满或 OAuth scope 不足。';
    case 404:
      return '资源不存在或当前凭证不可访问（检查 token / 序号是否正确）。';
    case 415:
      return '请求体必须是 JSON。';
    case 422:
      return '批量操作全部失败，见上面的逐条原因。';
    case 429:
      return `超过速率限制${res.retryAfter ? `，${res.retryAfter} 秒后重试` : '，稍后重试'}。`;
    default:
      return status >= 500 ? '金数据服务端错误，稍后重试；若持续出现请反馈。' : '';
  }
}

export function toToolResult(tool: ToolSpec, res: ApiResponse, maxResultChars: number): CallToolResult {
  const note = res.warnings ? `\n⚠ 服务端参数提示（X-API-Input-Warnings）：${res.warnings}` : '';
  if (res.status >= 200 && res.status < 300) {
    const payload = res.json;
    let text = payload === undefined ? (res.text ?? '') : JSON.stringify(payload);
    let truncated = false;
    if (text.length > maxResultChars) {
      truncated = true;
      text =
        `${text.slice(0, maxResultChars)}\n…（结果已截断：共 ${text.length} 字符。` +
        '请用 fields / limit / filters / keyword 缩小范围，或按 next 分页读取。）';
    }
    const result: CallToolResult = { content: [{ type: 'text', text: text + note }] };
    if (tool.outputSchema) {
      // 声明了 outputSchema 的工具必须给 structuredContent。截断时不把整个大结果再塞一遍，只给一个说明对象。
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
  const lines = [`HTTP ${res.status}：${tool.name} 失败。`, ...errorLines(res)];
  const h = hint(res.status, res);
  if (h) lines.push(h);
  return { isError: true, content: [{ type: 'text', text: lines.join('\n') + note }] };
}
