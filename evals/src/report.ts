/**
 * 报告：从 runs.jsonl 聚合出「模型 × MCP × 类别」的通过率表、token 表、轮次 / 报错 / 耗时表、任务明细与失败原因。
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
          : r.assertions.filter((a) => !a.pass).map((a) => `${a.name}${a.detail ? `（${a.detail}）` : ''}`)
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
      if (r.status === 'error') counts.set('运行错误', (counts.get('运行错误') ?? 0) + 1);
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
  const colNames = [...s.categories, '总计'];
  const out: string[] = [];
  const started = meta.started_at.slice(0, 16).replace('T', ' ');
  out.push(`# MCP 评测报告 ${meta.run_id}`, '');
  out.push(
    `- 时间：${started} UTC（完成 ${meta.finished_at?.slice(0, 16).replace('T', ' ') ?? '未完成'}）`,
    `- 任务：${meta.task_count} 个 × 模型 ${meta.models.length} 个 × MCP ${meta.targets.length} 个 × 重复 ${meta.repeat} 次 = ${Object.values(s.cells).find((c) => c)?.runs !== undefined ? (s.cells[cellKey('*', meta.targets[0]!.name, '*')]?.runs ?? 0) : 0} 次/MCP`,
    `- 测评账户：${meta.account.billing_account_name}（${meta.account.user_name}）`,
    `- judge 模型：${meta.judge_model}（只用于 claims 断言）`,
    `- LLM 网关：${meta.llm_base_url}`,
    ''
  );
  out.push('## 被测对象', '');
  out.push(
    table(
      ['MCP', '版本', '工具数', 'tools/list 大小', '估算 token'],
      meta.targets.map((t) => [
        t.name,
        `\`${t.version}\``,
        `${t.tool_count}`,
        `${k(t.catalog_chars)} 字符`,
        `≈ ${k(t.catalog_chars / 3.5)}`
      ])
    ),
    '',
    '> 估算 token 按 3.5 字符 / token 粗略折算，只用于比较两边目录大小；每轮对话都会带上整个目录。',
    ''
  );

  out.push('## 通过率（模型 × MCP × 类别）', '');
  out.push(
    table(
      ['模型', 'MCP', ...colNames],
      s.combos.map(({ model, mcp }) => [model, mcp, ...cols.map((c) => pct(s.cells[cellKey(model, mcp, c)]))])
    ),
    ''
  );
  out.push('按 MCP 汇总（所有模型）：', '');
  out.push(
    table(
      ['MCP', ...colNames],
      meta.targets.map((t) => [t.name, ...cols.map((c) => pct(s.cells[cellKey('*', t.name, c)]))])
    ),
    ''
  );

  out.push('## 平均 token（输入 / 输出，每个任务）', '');
  out.push(
    table(
      ['模型', 'MCP', ...colNames],
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

  out.push('## 轮次、工具调用、报错与耗时（每个任务平均）', '');
  out.push(
    table(
      ['模型', 'MCP', '轮次', '工具调用', '工具报错', '报错后重试', '结果截断', '耗时', '运行错误'],
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

  out.push('## 任务明细', '');
  const comboKeys = s.combos.map((c) => `${c.model}|${c.mcp}`);
  const short = (m: string) => m.replace(/^anthropic-claude-/, 'claude-').replace(/^openai-/, '');
  out.push(
    table(
      ['任务', '类别', ...s.combos.map((c) => `${short(c.model)} × ${c.mcp}`)],
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

  out.push('## 失败原因 Top（按 MCP）', '');
  for (const t of meta.targets) {
    out.push(`### ${t.name}`, '');
    const list = s.failures[t.name] ?? [];
    out.push(list.length ? list.map((f) => `- ${f.count} × ${f.name}`).join('\n') : '- （无）', '');
  }

  out.push('## 失败明细', '');
  for (const t of s.tasks) {
    const lines: string[] = [];
    for (const key of comboKeys) {
      for (const r of t.results[key] ?? []) {
        if (r.status === 'passed') continue;
        lines.push(`- ${key.replace('|', ' × ')}：${r.reasons.slice(0, 4).join('；')}`);
      }
    }
    if (lines.length) out.push(`### ${t.id}（${t.category}）`, '', ...lines, '');
  }

  out.push('## 工具调用分布（按 MCP）', '');
  for (const t of meta.targets) {
    const list = (s.tool_usage[t.name] ?? []).slice(0, 25);
    out.push(`### ${t.name}`, '');
    out.push(
      table(
        ['工具', '调用', '报错'],
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
