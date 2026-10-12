/**
 * OpenAI 兼容的 chat/completions 调用：任何支持 function calling 的模型都能接进来（网关统一鉴权）。
 * 负责重试（429 / 5xx / 网络）、用量归一化、MCP 工具 → OpenAI tools 的转换。
 */
import type { Tool } from '@modelcontextprotocol/client';
import type { Usage } from './types.js';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries?: number;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
}

export interface ChatResult {
  message: AssistantMessage;
  finish_reason: string;
  usage: Usage;
  latency_ms: number;
  retries: number;
  raw_model?: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly body?: string
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function normalizeUsage(raw: Record<string, unknown> | undefined): Usage {
  const prompt = (raw?.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completion = (raw?.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    prompt_tokens: num(raw?.prompt_tokens ?? raw?.input_tokens),
    completion_tokens: num(raw?.completion_tokens ?? raw?.output_tokens),
    cached_tokens: num(prompt.cached_tokens),
    reasoning_tokens: num(completion.reasoning_tokens)
  };
}

export async function chatCompletion(
  cfg: LlmConfig,
  params: {
    model: string;
    messages: ChatMessage[];
    tools?: OpenAiTool[];
    signal?: AbortSignal;
    extra?: Record<string, unknown>;
  }
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    ...(params.tools?.length ? { tools: params.tools, tool_choice: 'auto' } : {}),
    ...params.extra
  };
  const maxRetries = cfg.maxRetries ?? 5;
  let retries = 0;
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    const onAbort = () => controller.abort();
    params.signal?.addEventListener('abort', onAbort, { once: true });
    let res: Response | undefined;
    let text = '';
    let failure: LlmError | undefined;
    try {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      text = await res.text();
      if (!res.ok) {
        // 网关对同一模型多路由时偶发 404 model_not_found，当作可重试
        const flaky404 = res.status === 404 && /does not exist|not found/i.test(text);
        failure = new LlmError(
          `LLM HTTP ${res.status}: ${text.slice(0, 500)}`,
          res.status,
          RETRYABLE.has(res.status) || flaky404,
          text
        );
      }
    } catch (error) {
      const aborted = params.signal?.aborted;
      const timedOut = controller.signal.aborted && !aborted;
      failure = new LlmError(
        timedOut ? `LLM 调用超时（${cfg.timeoutMs} ms）` : `LLM 网络错误：${(error as Error).message}`,
        undefined,
        !aborted,
        undefined
      );
      if (aborted) throw failure;
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', onAbort);
    }
    if (!failure && res) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new LlmError(`LLM 返回了非 JSON：${text.slice(0, 300)}`, res.status, false, text);
      }
      if (data.error) {
        const err = data.error as Record<string, unknown>;
        const msg = typeof err === 'string' ? err : String(err.message ?? JSON.stringify(err));
        const code = Number(err.code);
        const retryable = /rate|limit|overloaded|timeout|temporar|busy/i.test(msg) || RETRYABLE.has(code);
        failure = new LlmError(
          `LLM 错误：${msg.slice(0, 500)}`,
          Number.isFinite(code) ? code : res.status,
          retryable,
          text
        );
      } else {
        const choice = ((data.choices as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
        const message = (choice.message ?? {}) as Record<string, unknown>;
        const toolCalls = Array.isArray(message.tool_calls)
          ? (message.tool_calls as Record<string, unknown>[]).map((tc, i) => {
              const fn = (tc.function ?? {}) as Record<string, unknown>;
              const args = fn.arguments;
              return {
                id: String(tc.id ?? `call_${i}`),
                type: 'function' as const,
                function: {
                  name: String(fn.name ?? ''),
                  arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {})
                }
              };
            })
          : undefined;
        const out: AssistantMessage = {
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : null,
          ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
          ...(typeof message.reasoning_content === 'string' && message.reasoning_content
            ? { reasoning_content: message.reasoning_content }
            : {})
        };
        return {
          message: out,
          finish_reason: String(choice.finish_reason ?? ''),
          usage: normalizeUsage(data.usage as Record<string, unknown> | undefined),
          latency_ms: Date.now() - started,
          retries,
          raw_model: typeof data.model === 'string' ? data.model : undefined
        };
      }
    }
    if (!failure!.retryable || attempt >= maxRetries) throw failure!;
    retries++;
    const retryAfter = Number(res?.headers.get('retry-after'));
    const backoff =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 1500 * 2 ** attempt);
    await sleep(backoff + Math.random() * 500);
  }
}

/** OpenAI 对 function description 的长度上限（字符）；超出时截断并计数，报告里会提到。 */
export const OPENAI_DESCRIPTION_LIMIT = 1024;

function sanitizeSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'object', properties: {} };
  const copy = { ...(schema as Record<string, unknown>) };
  delete copy.$schema;
  delete copy.$id;
  if (!copy.type) copy.type = 'object';
  if (copy.type === 'object' && !copy.properties) copy.properties = {};
  return copy;
}

export function mcpToolsToOpenAi(
  tools: Tool[],
  options: { maxDescriptionChars?: number } = {}
): { tools: OpenAiTool[]; truncated_descriptions: number } {
  const limit = options.maxDescriptionChars ?? Number.POSITIVE_INFINITY;
  let truncated = 0;
  const out = tools.map((tool) => {
    let description = tool.description ?? tool.title ?? '';
    if (description.length > limit) {
      description = `${description.slice(0, limit - 1)}…`;
      truncated++;
    }
    return {
      type: 'function' as const,
      function: { name: tool.name, description, parameters: sanitizeSchema(tool.inputSchema) }
    };
  });
  return { tools: out, truncated_descriptions: truncated };
}
