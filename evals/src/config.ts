/**
 * 评测运行配置：全部来自环境变量（可放在 evals/.env.local，不进仓库）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVALS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = resolve(EVALS_DIR, '..');

/** 读取 evals/.env.local（KEY=VALUE，# 注释），已存在的环境变量优先。 */
export function loadEnvFile(path = resolve(EVALS_DIR, '.env.local')): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export interface EvalConfig {
  llmBaseUrl: string;
  llmApiKey: string;
  /** 缺省被测模型 */
  models: string[];
  judgeModel: string;
  builtinMcpUrl: string;
  /** 新 MCP 的 HTTP 部署地址；不设则进程内直连 buildServer */
  newMcpUrl?: string;
  stateDir: string;
  resultsDir: string;
  concurrency: number;
  /** 单次 LLM 调用超时 */
  llmTimeoutMs: number;
  /** 单次工具调用超时 */
  toolTimeoutMs: number;
  /** 工具结果喂给模型前的最大字符数（两个 MCP 一视同仁；缺省与新 MCP 自身的截断阈值一致） */
  maxToolResultChars: number;
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): EvalConfig {
  loadEnvFile();
  const llmBaseUrl = (env.LLM_BASE_URL ?? '').replace(/\/$/, '');
  return {
    llmBaseUrl,
    llmApiKey: env.LLM_API_KEY ?? '',
    models: list(env.EVAL_MODELS, [
      'anthropic-claude-sonnet-5',
      'anthropic-claude-45-haiku',
      'qwen3.8-max',
      'deepseek-v4.1-flash'
    ]),
    judgeModel: env.EVAL_JUDGE_MODEL ?? 'anthropic-claude-sonnet-5',
    builtinMcpUrl: env.EVAL_BUILTIN_MCP_URL ?? 'https://jinshuju.net/mcp',
    newMcpUrl: env.EVAL_NEW_MCP_URL || undefined,
    stateDir: env.EVAL_STATE_DIR ?? resolve(EVALS_DIR, 'state'),
    resultsDir: env.EVAL_RESULTS_DIR ?? resolve(EVALS_DIR, 'results'),
    concurrency: int(env.EVAL_CONCURRENCY, 4),
    llmTimeoutMs: int(env.EVAL_LLM_TIMEOUT_MS, 240_000),
    toolTimeoutMs: int(env.EVAL_TOOL_TIMEOUT_MS, 120_000),
    maxToolResultChars: int(env.EVAL_MAX_TOOL_RESULT_CHARS, 120_000)
  };
}

export function requireLlm(cfg: EvalConfig): void {
  if (!cfg.llmBaseUrl || !cfg.llmApiKey) {
    throw new Error(
      '需要 LLM_BASE_URL 与 LLM_API_KEY（OpenAI 兼容的 chat/completions 网关），可写在 evals/.env.local。'
    );
  }
}
