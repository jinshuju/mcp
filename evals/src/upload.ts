/**
 * Writes a run's results into the Jinshuju form "MCP 评测结果（自动写入）", one entry per job, for comparison over time.
 * Field labels and the result choices below are the existing form's own: the form is looked up by them, so they stay as written.
 */
import type { EvalApi } from './api.js';
import { flattenFields } from './api.js';
import type { EvalConfig } from './config.js';
import { saveState } from './fixtures.js';
import { readMeta, readRecords } from './runner.js';
import { CATEGORIES, type FixtureState, type FixturesSpec, type RunRecord } from './types.js';

const FIELDS: { key: string; type: string; label: string; choices?: string[]; precision?: string }[] = [
  { key: 'date', type: 'DateTimeField', label: '日期', precision: 'minute' },
  { key: 'run_id', type: 'TextField', label: '运行 ID' },
  { key: 'mcp', type: 'TextField', label: 'MCP' },
  { key: 'mcp_version', type: 'TextField', label: 'MCP 版本' },
  { key: 'model', type: 'TextField', label: '模型' },
  { key: 'task_id', type: 'TextField', label: '任务 ID' },
  { key: 'category', type: 'RadioButton', label: '任务类别', choices: [...CATEGORIES] },
  { key: 'result', type: 'RadioButton', label: '结果', choices: ['通过', '失败', '运行错误'] },
  { key: 'assertions', type: 'TextArea', label: '断言明细' },
  { key: 'prompt_tokens', type: 'NumberField', label: '输入 token' },
  { key: 'completion_tokens', type: 'NumberField', label: '输出 token' },
  { key: 'turns', type: 'NumberField', label: '轮次' },
  { key: 'tool_calls', type: 'NumberField', label: '工具调用数' },
  { key: 'tool_errors', type: 'NumberField', label: '工具报错数' },
  { key: 'duration', type: 'NumberField', label: '耗时（秒）' },
  { key: 'tools', type: 'TextArea', label: '工具序列' },
  { key: 'answer', type: 'TextArea', label: '最终答复' },
  { key: 'judge', type: 'TextField', label: 'judge 模型' }
];

export async function ensureResultsForm(
  api: EvalApi,
  cfg: EvalConfig,
  spec: FixturesSpec,
  state: FixtureState,
  log: (s: string) => void = () => {}
): Promise<{ token: string; fields: Record<string, string>; url: string }> {
  let token = state.results_form_token;
  if (token) {
    try {
      await api.getForm(token);
    } catch {
      token = undefined;
    }
  }
  if (!token) {
    const rows = await api.listForms({
      filters: [{ field: 'form_name', operator: 'eq', value: spec.results_form }],
      limit: 10
    });
    token = rows.find((r) => r.name === spec.results_form)?.token;
  }
  if (!token) {
    const created = await api.createForm({
      name: spec.results_form,
      description: 'Written by the evals/ runner; each entry is the result of one task × model × MCP job.',
      folder_token: state.folder_token,
      fields: FIELDS.map((f) => ({
        type: f.type,
        label: f.label,
        ...(f.choices ? { choices: f.choices.map((value) => ({ value })) } : {}),
        ...(f.precision ? { precision: f.precision } : {})
      }))
    });
    token = created.token;
    log(`Created results form "${spec.results_form}" ${token}`);
  }
  state.results_form_token = token;
  saveState(cfg, state);
  const form = await api.getForm(token);
  const byLabel = new Map(flattenFields(form).map(({ api_code, def }) => [def.label, api_code]));
  const fields: Record<string, string> = {};
  for (const f of FIELDS) {
    const code = byLabel.get(f.label);
    if (!code) throw new Error(`The results form has no field "${f.label}"`);
    fields[f.key] = code;
  }
  return { token, fields, url: form.url };
}

function beijing(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

export function toEntry(fields: Record<string, string>, r: RunRecord): Record<string, unknown> {
  const assertions = r.assertions
    .map((a) => `${a.pass ? '✓' : '✗'} ${a.name}${a.detail ? ` — ${a.detail}` : ''}`)
    .join('\n');
  return {
    [fields.date!]: beijing(r.finished_at),
    [fields.run_id!]: r.run_id,
    [fields.mcp!]: r.mcp,
    [fields.mcp_version!]: r.mcp_version,
    [fields.model!]: r.model,
    [fields.task_id!]: r.task_id,
    [fields.category!]: r.category,
    [fields.result!]: r.status === 'passed' ? '通过' : r.status === 'failed' ? '失败' : '运行错误',
    [fields.assertions!]: (r.error ? `${assertions}\n${r.error}` : assertions).slice(0, 5000),
    [fields.prompt_tokens!]: r.usage.prompt_tokens,
    [fields.completion_tokens!]: r.usage.completion_tokens,
    [fields.turns!]: r.turns,
    [fields.tool_calls!]: r.tool_calls,
    [fields.tool_errors!]: r.tool_errors,
    [fields.duration!]: Math.round(r.duration_ms / 1000),
    [fields.tools!]: r.calls
      .map((c) => `${c.is_error ? '✗' : ''}${c.name}`)
      .join(' → ')
      .slice(0, 5000),
    [fields.answer!]: r.final_answer.slice(0, 5000),
    [fields.judge!]: r.judge_model ?? ''
  };
}

export async function uploadRun(
  api: EvalApi,
  cfg: EvalConfig,
  spec: FixturesSpec,
  state: FixtureState,
  runDir: string,
  log: (s: string) => void = () => {}
): Promise<{ token: string; url: string; uploaded: number }> {
  const meta = readMeta(runDir);
  const records = readRecords(runDir);
  const { token, fields, url } = await ensureResultsForm(api, cfg, spec, state, log);
  // Idempotent: a (run_id, job) already uploaded is not written again
  const existing = await api.listAllEntries(token, {
    filters: [{ field: fields.run_id!, operator: 'eq', value: meta.run_id }],
    fields: [fields.task_id!, fields.model!, fields.mcp!]
  });
  const seen = new Set(existing.map((e) => `${e[fields.task_id!]}|${e[fields.model!]}|${e[fields.mcp!]}`));
  const pending = records.filter((r) => !seen.has(`${r.task_id}|${r.model}|${r.mcp}`));
  let uploaded = 0;
  for (let i = 0; i < pending.length; i += 200) {
    const chunk = pending.slice(i, i + 200);
    await api.createEntriesBatch(
      token,
      chunk.map((r) => toEntry(fields, r))
    );
    uploaded += chunk.length;
    log(`  Written ${uploaded}/${pending.length}`);
  }
  return { token, url, uploaded };
}
