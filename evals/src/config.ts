/**
 * Eval run configuration, all from environment variables (they can live in evals/.env.local, which is not committed).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVALS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = resolve(EVALS_DIR, '..');

/** Reads evals/.env.local (KEY=VALUE, # comments); variables already in the environment win. */
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
  /** Models under test by default */
  models: string[];
  judgeModel: string;
  /** HTTP address of a deployment to test as `new`; unset, buildServer is connected in process */
  newMcpUrl?: string;
  stateDir: string;
  resultsDir: string;
  concurrency: number;
  /** Timeout of one LLM call */
  llmTimeoutMs: number;
  /** Timeout of one tool call */
  toolTimeoutMs: number;
  /** Most characters of a tool result passed to the model (defaults to the server's own truncation threshold) */
  maxToolResultChars: number;
  /** Pass rate (percent) under which `run` exits 1; unset, a run never fails on its results */
  minPassRate?: number;
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

function percent(value: string | undefined): number | undefined {
  const n = Number(value);
  return value && Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): EvalConfig {
  loadEnvFile();
  const llmBaseUrl = (env.LLM_BASE_URL ?? '').replace(/\/$/, '');
  return {
    llmBaseUrl,
    llmApiKey: env.LLM_API_KEY ?? '',
    models: list(env.EVAL_MODELS, [
      'openai-gpt-5.6-luna',
      'anthropic-claude-haiku-5-5',
      'qwen3.7-plus',
      'deepseek-v4.1-flash'
    ]),
    judgeModel: env.EVAL_JUDGE_MODEL ?? 'anthropic-claude-sonnet-5-5',
    newMcpUrl: env.EVAL_NEW_MCP_URL || undefined,
    stateDir: env.EVAL_STATE_DIR ?? resolve(EVALS_DIR, 'state'),
    resultsDir: env.EVAL_RESULTS_DIR ?? resolve(EVALS_DIR, 'results'),
    concurrency: int(env.EVAL_CONCURRENCY, 4),
    llmTimeoutMs: int(env.EVAL_LLM_TIMEOUT_MS, 240_000),
    toolTimeoutMs: int(env.EVAL_TOOL_TIMEOUT_MS, 120_000),
    maxToolResultChars: int(env.EVAL_MAX_TOOL_RESULT_CHARS, 120_000),
    minPassRate: percent(env.EVAL_MIN_PASS_RATE)
  };
}

export function requireLlm(cfg: EvalConfig): void {
  if (!cfg.llmBaseUrl || !cfg.llmApiKey) {
    throw new Error(
      'Needs LLM_BASE_URL and LLM_API_KEY (an OpenAI-compatible chat/completions gateway); they can go in evals/.env.local.'
    );
  }
}
