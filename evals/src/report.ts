/**
 * Report: aggregates runs.jsonl into pass rates by model × MCP × category, tokens, turns / errors / duration, per-task results and failure reasons.
 * Category names are data (see CATEGORIES) and appear as written in the column headers.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readMeta, readRecords } from './runner.js';
import { CATEGORIES, type Category, type RunMeta, type RunRecord } from './types.js';

export interface Cell {
  runs: number;
  passed: number;
  errors: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  turns: number;
  tool_calls: number;
  tool_errors: number;
  tool_retries: number;
  duration_ms: number;
  truncated_results: number;
}

export interface Summary {
  meta: RunMeta;
  combos: { model: string; mcp: string }[];
  categories: Category[];
  cells: Record<string, Cell>;
  tasks: { id: string; category: Category; results: Record<string, { status: string; reasons: string[] }[]> }[];
  failures: Record<string, { name: string; count: number }[]>;
  tool_usage: Record<string, { name: string; calls: number; errors: number }[]>;
}

const empty = (): Cell => ({
  runs: 0,
  passed: 0,
  errors: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  cached_tokens: 0,
  turns: 0,
  tool_calls: 0,
  tool_errors: 0,
  tool_retries: 0,
  duration_ms: 0,
  truncated_results: 0
});

function add(cell: Cell, r: RunRecord): void {
  cell.runs++;
  if (r.passed) cell.passed++;
  if (r.status === 'error') cell.errors++;
  cell.prompt_tokens += r.usage.prompt_tokens;
  cell.completion_tokens += r.usage.completion_tokens;
  cell.cached_tokens += r.usage.cached_tokens;
  cell.turns += r.turns;
  cell.tool_calls += r.tool_calls;
  cell.tool_errors += r.tool_errors;
  cell.tool_retries += r.tool_retries;
  cell.duration_ms += r.duration_ms;
  cell.truncated_results += r.truncated_results;
}

export const cellKey = (model: string, mcp: string, category: string) => `${model}|${mcp}|${category}`;

export function buildSummary(meta: RunMeta, records: RunRecord[]): Summary {
  const cells: Record<string, Cell> = {};
  const combos: { model: string; mcp: string }[] = [];
  for (const model of meta.models) for (const t of meta.targets) combos.push({ model, mcp: t.name });
  for (const r of records) {
    if (!combos.some((c) => c.model === r.model && c.mcp === r.mcp)) combos.push({ model: r.model, mcp: r.mcp });
    for (const key of [
      cellKey(r.model, r.mcp, r.category),
      cellKey(r.model, r.mcp, '*'),
      cellKey('*', r.mcp, r.category),
      cellKey('*', r.mcp, '*')
    ]) {
      add((cells[key] ??= empty()), r);
    }
  }
  const categories = CATEGORIES.filter((c) => records.some((r) => r.category === c));
  const taskMap = new Map<string, Summary['tasks'][number]>();
  for (const r of records) {
    let t = taskMap.get(r.task_id);
    if (!t) taskMap.set(r.task_id, (t = { id: r.task_id, category: r.category, results: {} }));
    const key = `${r.model}|${r.mcp}`;
    (t.results[key] ??= []).push({
      status: r.status,
      reasons:
        r.status === 'error'
          ? [r.error?.split('\n')[0] ?? 'error']
          : r.assertions.filter((a) => !a.pass).map((a) => `${a.name}${a.detail ? ` (${a.detail})` : ''}`)
    });
  }
  const tasks = [...taskMap.values()].sort(
    (a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.id.localeCompare(b.id)
  );

  const failures: Summary['failures'] = {};
  const toolUsage: Summary['tool_usage'] = {};
  for (const t of meta.targets) {
    const counts = new Map<string, number>();
    const tools = new Map<string, { calls: number; errors: number }>();
    for (const r of records.filter((r) => r.mcp === t.name)) {
      for (const a of r.assertions.filter((a) => !a.pass)) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
      if (r.status === 'error') counts.set('run error', (counts.get('run error') ?? 0) + 1);
      for (const c of r.calls) {
        const u = tools.get(c.name) ?? { calls: 0, errors: 0 };
        u.calls++;
        if (c.is_error) u.errors++;
        tools.set(c.name, u);
      }
    }
    failures[t.name] = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
    toolUsage[t.name] = [...tools.entries()].map(([name, u]) => ({ name, ...u })).sort((a, b) => b.calls - a.calls);
  }
  return { meta, combos, categories, cells, tasks, failures, tool_usage: toolUsage };
}

const pct = (c: Cell | undefined) =>
  c && c.runs ? `${Math.round((100 * c.passed) / c.runs)}% (${c.passed}/${c.runs})` : '–';
const k = (n: number) =>
  n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;
const avg = (c: Cell | undefined, f: (c: Cell) => number) => (c && c.runs ? f(c) / c.runs : 0);

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

export function renderMarkdown(s: Summary): string {
  const { meta } = s;
  const cols = [...s.categories, '*'];
  const colNames = [...s.categories, 'Total'];
  const out: string[] = [];
  const started = meta.started_at.slice(0, 16).replace('T', ' ');
  out.push(`# MCP eval report ${meta.run_id}`, '');
  out.push(
    `- Time: ${started} UTC (finished ${meta.finished_at?.slice(0, 16).replace('T', ' ') ?? 'not finished'})`,
    `- Jobs: ${meta.task_count} tasks × ${meta.models.length} models × ${meta.targets.length} MCPs × ${meta.repeat} repeats = ${Object.values(s.cells).find((c) => c)?.runs !== undefined ? (s.cells[cellKey('*', meta.targets[0]!.name, '*')]?.runs ?? 0) : 0} per MCP`,
    `- Eval account: ${meta.account.billing_account_name} (${meta.account.user_name})`,
    `- Judge model: ${meta.judge_model} (claims assertions only)`,
    `- LLM gateway: ${meta.llm_base_url}`,
    ''
  );
  out.push('## MCPs under test', '');
  out.push(
    table(
      ['MCP', 'Version', 'Tools', 'tools/list size', 'Estimated tokens'],
      meta.targets.map((t) => [
        t.name,
        `\`${t.version}\``,
        `${t.tool_count}`,
        `${k(t.catalog_chars)} chars`,
        `≈ ${k(t.catalog_chars / 3.5)}`
      ])
    ),
    '',
    '> Estimated tokens assume a rough 3.5 characters per token and only compare catalog sizes; every turn carries the whole catalog.',
    ''
  );

  out.push('## Pass rate (model × MCP × category)', '');
  out.push(
    table(
      ['Model', 'MCP', ...colNames],
      s.combos.map(({ model, mcp }) => [model, mcp, ...cols.map((c) => pct(s.cells[cellKey(model, mcp, c)]))])
    ),
    ''
  );
  out.push('By MCP (all models):', '');
  out.push(
    table(
      ['MCP', ...colNames],
      meta.targets.map((t) => [t.name, ...cols.map((c) => pct(s.cells[cellKey('*', t.name, c)]))])
    ),
    ''
  );

  out.push('## Average tokens (input / output, per task)', '');
  out.push(
    table(
      ['Model', 'MCP', ...colNames],
      s.combos.map(({ model, mcp }) => [
        model,
        mcp,
        ...cols.map((c) => {
          const cell = s.cells[cellKey(model, mcp, c)];
          return cell && cell.runs
            ? `${k(avg(cell, (x) => x.prompt_tokens))} / ${k(avg(cell, (x) => x.completion_tokens))}`
            : '–';
        })
      ])
    ),
    ''
  );

  out.push('## Turns, tool calls, errors and duration (average per task)', '');
  out.push(
    table(
      [
        'Model',
        'MCP',
        'Turns',
        'Tool calls',
        'Tool errors',
        'Retries after an error',
        'Truncated results',
        'Duration',
        'Run errors'
      ],
      s.combos.map(({ model, mcp }) => {
        const cell = s.cells[cellKey(model, mcp, '*')];
        return [
          model,
          mcp,
          avg(cell, (x) => x.turns).toFixed(1),
          avg(cell, (x) => x.tool_calls).toFixed(1),
          avg(cell, (x) => x.tool_errors).toFixed(2),
          avg(cell, (x) => x.tool_retries).toFixed(2),
          avg(cell, (x) => x.truncated_results).toFixed(2),
          `${(avg(cell, (x) => x.duration_ms) / 1000).toFixed(0)}s`,
          `${cell?.errors ?? 0}`
        ];
      })
    ),
    ''
  );

  out.push('## Tasks', '');
  const comboKeys = s.combos.map((c) => `${c.model}|${c.mcp}`);
  const short = (m: string) => m.replace(/^anthropic-claude-/, 'claude-').replace(/^openai-/, '');
  out.push(
    table(
      ['Task', 'Category', ...s.combos.map((c) => `${short(c.model)} × ${c.mcp}`)],
      s.tasks.map((t) => [
        t.id,
        t.category,
        ...comboKeys.map((key) => {
          const rs = t.results[key] ?? [];
          if (!rs.length) return '–';
          return rs.map((r) => (r.status === 'passed' ? '✓' : r.status === 'error' ? '⚠' : '✗')).join('');
        })
      ])
    ),
    ''
  );

  out.push('## Top failure reasons (by MCP)', '');
  for (const t of meta.targets) {
    out.push(`### ${t.name}`, '');
    const list = s.failures[t.name] ?? [];
    out.push(list.length ? list.map((f) => `- ${f.count} × ${f.name}`).join('\n') : '- (none)', '');
  }

  out.push('## Failures', '');
  for (const t of s.tasks) {
    const lines: string[] = [];
    for (const key of comboKeys) {
      for (const r of t.results[key] ?? []) {
        if (r.status === 'passed') continue;
        lines.push(`- ${key.replace('|', ' × ')}: ${r.reasons.slice(0, 4).join('; ')}`);
      }
    }
    if (lines.length) out.push(`### ${t.id} (${t.category})`, '', ...lines, '');
  }

  out.push('## Tool calls (by MCP)', '');
  for (const t of meta.targets) {
    const list = (s.tool_usage[t.name] ?? []).slice(0, 25);
    out.push(`### ${t.name}`, '');
    out.push(
      table(
        ['Tool', 'Calls', 'Errors'],
        list.map((u) => [u.name, `${u.calls}`, `${u.errors}`])
      ),
      ''
    );
  }
  return out.join('\n');
}

export function writeReport(runDir: string): { summary: Summary; markdown: string } {
  const meta = readMeta(runDir);
  const records = readRecords(runDir);
  const summary = buildSummary(meta, records);
  const markdown = renderMarkdown(summary);
  writeFileSync(resolve(runDir, 'report.md'), `${markdown}\n`);
  writeFileSync(resolve(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, markdown };
}
