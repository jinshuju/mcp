/**
 * A minimal agent loop: system prompt + task → model → tool calls → results fed back → … → final answer.
 * Both MCPs get the same treatment: the same system prompt (plus each one's instructions), the same result truncation, the same turn limit.
 * Everything the model under test reads from the harness (the system prompt, tool-call errors, the truncation note) stays in
 * Chinese: the tasks are Chinese users' requests, and rewording any of it would break comparison with past rounds.
 */
import {
  chatCompletion,
  mcpToolsToOpenAi,
  type ChatMessage,
  type LlmConfig,
  type OpenAiTool,
  LlmError
} from './llm.js';
import { callTool, type ConnectedMcp } from './mcp.js';
import type { Task, ToolCallRecord, TurnUsage } from './types.js';

export interface AgentOptions {
  task: Task;
  mcp: ConnectedMcp;
  model: string;
  llm: LlmConfig;
  maxTurns: number;
  maxToolResultChars: number;
  toolTimeoutMs: number;
  /** OpenAI's function description limit; undefined means no truncation */
  descriptionLimit?: number;
  today?: string;
  log?: (line: string) => void;
}

export interface AgentTrace {
  final_answer: string;
  messages: ChatMessage[];
  calls: ToolCallRecord[];
  turn_usage: TurnUsage[];
  turns: number;
  tool_calls: number;
  tool_errors: number;
  tool_retries: number;
  llm_retries: number;
  truncated_results: number;
  truncated_descriptions: number;
  exhausted: boolean;
  error?: string;
}

export function systemPrompt(mcp: ConnectedMcp, today: string): string {
  const lines = [
    '你是金数据（Jinshuju）的 AI 助手，通过提供的工具替用户查看和操作他的表单与数据。',
    `今天是 ${today}（北京时间）。`,
    '要求：',
    '- 直接用工具完成任务，不要向用户反问；缺的信息尽量通过工具查到。',
    '- 工具报错时根据错误信息修正参数再试；确实做不到就说明原因。',
    '- 完成后用中文给出简洁的最终答复，把用户要的事实（数字、名单、链接等）写清楚。'
  ];
  if (mcp.instructions?.trim()) lines.push('', '以下是 MCP 服务自带的说明：', mcp.instructions.trim());
  return lines.join('\n');
}

function preview(text: string, n = 300): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

export async function runAgent(options: AgentOptions): Promise<AgentTrace> {
  const { task, mcp, model, llm, log } = options;
  const today = options.today ?? new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const converted = mcpToolsToOpenAi(mcp.tools, { maxDescriptionChars: options.descriptionLimit });
  const tools: OpenAiTool[] = converted.tools;
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(mcp, today) },
    { role: 'user', content: task.prompt }
  ];
  const trace: AgentTrace = {
    final_answer: '',
    messages,
    calls: [],
    turn_usage: [],
    turns: 0,
    tool_calls: 0,
    tool_errors: 0,
    tool_retries: 0,
    llm_retries: 0,
    truncated_results: 0,
    truncated_descriptions: converted.truncated_descriptions,
    exhausted: false
  };
  const lastErrorByTool = new Map<string, boolean>();

  for (let turn = 1; turn <= options.maxTurns; turn++) {
    trace.turns = turn;
    let result;
    try {
      result = await chatCompletion(llm, { model, messages, tools });
    } catch (error) {
      trace.error = error instanceof LlmError ? error.message : `LLM call failed: ${(error as Error).message}`;
      log?.(`  ✗ ${trace.error.slice(0, 200)}`);
      return trace;
    }
    trace.llm_retries += result.retries;
    trace.turn_usage.push({ turn, ...result.usage, latency_ms: result.latency_ms });
    const msg = result.message;
    const assistant: ChatMessage = {
      role: 'assistant',
      content: msg.content ?? '',
      ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
      ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {})
    };
    messages.push(assistant);

    if (!msg.tool_calls?.length) {
      trace.final_answer = (msg.content ?? '').trim();
      return trace;
    }

    for (const call of msg.tool_calls) {
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      let parseError: string | undefined;
      try {
        const parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        else parseError = '参数必须是 JSON 对象';
      } catch (error) {
        parseError = `参数不是合法 JSON：${(error as Error).message}`;
      }
      const started = Date.now();
      const outcome = parseError
        ? { text: parseError, is_error: true, duration_ms: 0 }
        : mcp.tools.some((t) => t.name === name)
          ? await callTool(mcp, name, args, options.toolTimeoutMs)
          : { text: `没有名为 ${name} 的工具`, is_error: true, duration_ms: 0 };
      trace.tool_calls++;
      if (outcome.is_error) {
        trace.tool_errors++;
        if (lastErrorByTool.get(name)) trace.tool_retries++;
      } else if (lastErrorByTool.get(name)) {
        trace.tool_retries++;
      }
      lastErrorByTool.set(name, outcome.is_error);
      let text = outcome.text;
      if (text.length > options.maxToolResultChars) {
        text = `${text.slice(0, options.maxToolResultChars)}\n…（结果过长已截断，共 ${outcome.text.length} 字符；请缩小范围或分页）`;
        trace.truncated_results++;
      }
      trace.calls.push({
        index: trace.calls.length + 1,
        turn,
        name,
        arguments: args,
        is_error: outcome.is_error,
        result_chars: outcome.text.length,
        result_preview: preview(outcome.text),
        duration_ms: outcome.duration_ms || Date.now() - started,
        ...(outcome.is_error ? { error_message: preview(outcome.text, 500) } : {})
      });
      log?.(
        `  ${outcome.is_error ? '✗' : '✓'} ${name} ${preview(JSON.stringify(args), 120)} → ${outcome.text.length} chars`
      );
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.is_error ? `ERROR: ${text}` : text });
    }
  }
  trace.exhausted = true;
  const lastAssistant = messages.toReversed().find((m) => m.role === 'assistant' && m.content);
  trace.final_answer = lastAssistant && lastAssistant.role === 'assistant' ? (lastAssistant.content ?? '').trim() : '';
  return trace;
}
