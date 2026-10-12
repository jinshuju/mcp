/**
 * 断言：工具调用序列、轮次、最终答复（子串 / 正则 / LLM judge）、运行后的真实状态（通过 API 读回来核对）。
 * 一个任务通过 = 全部断言通过。
 */
import { EvalApi, flattenFields, type FieldDef, type FormDetail } from './api.js';
import { sameValue } from './fixtures.js';
import type { LlmConfig } from './llm.js';
import { judgeClaims } from './judge.js';
import type {
  AssertionResult,
  FieldExpect,
  FixtureState,
  FixturesSpec,
  StateCheck,
  Task,
  TaskFilter
} from './types.js';
import type { AgentTrace } from './agent.js';

export interface AssertContext {
  api: EvalApi;
  state: FixtureState;
  spec: FixturesSpec;
  runStartedAt: Date;
  llm: LlmConfig;
  judgeModel: string;
}

const stripHtml = (s: string | null | undefined) =>
  (s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

/** 答复里的全角数字 / 逗号归一化，便于子串匹配 */
function normalize(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export class Templates {
  private plan?: Promise<string>;
  constructor(
    private readonly api: EvalApi,
    private readonly state: FixtureState
  ) {}
  async render(text: string): Promise<string> {
    const matches = [...text.matchAll(/\{\{\s*([\w-]+)\.(\w+)\s*\}\}/g)];
    let out = text;
    for (const m of matches) {
      const [whole, alias, prop] = m;
      let value: string | undefined;
      if (alias === 'account') {
        if (prop === 'plan') {
          this.plan ??= this.api.billingAccount().then((b) => b.plan?.name ?? '');
          value = await this.plan;
        }
      } else {
        const form = this.state.forms[alias!];
        if (form) value = String((form as unknown as Record<string, unknown>)[prop!] ?? '');
      }
      if (value === undefined) throw new Error(`模板 ${whole} 无法解析`);
      out = out.split(whole).join(value);
    }
    return out;
  }
}

function fieldTypeOk(def: FieldDef, expect: FieldExpect): boolean {
  if (!expect.type) return true;
  const types = Array.isArray(expect.type) ? expect.type : [expect.type];
  return types.includes(def.type);
}

function checkField(fields: { api_code: string; def: FieldDef }[], index: number, expect: FieldExpect): string[] {
  const { def } = fields[index]!;
  const problems: string[] = [];
  if (!fieldTypeOk(def, expect)) problems.push(`类型是 ${def.type}，期望 ${[expect.type].flat().join('/')}`);
  const validation = (def.validation ?? {}) as Record<string, unknown>;
  if (expect.required !== undefined && !!validation.required !== expect.required) {
    problems.push(expect.required ? '不是必填' : '不应必填');
  }
  if (expect.unique !== undefined && !!validation.unique !== expect.unique) {
    problems.push(expect.unique ? '没有设置不允许重复' : '不应设置唯一');
  }
  const names = (def.choices ?? []).filter((c) => !c.hidden).map((c) => c.name);
  if (expect.choices !== undefined && names.length !== expect.choices) {
    problems.push(`选项数 ${names.length}，期望 ${expect.choices}`);
  }
  if (expect.choices_min !== undefined && names.length < expect.choices_min) {
    problems.push(`选项数 ${names.length}，至少 ${expect.choices_min}`);
  }
  for (const want of expect.choices_include ?? []) {
    if (!names.some((n) => n.trim() === want)) problems.push(`缺少选项「${want}」`);
  }
  if (expect.after_label) {
    const anchor = fields.findIndex(({ def: d }) => d.label === expect.after_label);
    if (anchor < 0) problems.push(`找不到锚点字段「${expect.after_label}」`);
    else if (index !== anchor + 1) problems.push(`位置不在「${expect.after_label}」之后`);
  }
  return problems;
}

/** 在字段列表里找满足期望的字段；fields 里每个期望匹配互不相同的字段。 */
function matchFields(form: FormDetail, expects: FieldExpect[]): AssertionResult[] {
  const fields = flattenFields(form);
  const used = new Set<number>();
  const results: AssertionResult[] = [];
  for (const expect of expects) {
    const label = expect.label ?? expect.label_contains ?? [expect.type].flat().join('/');
    const candidates = fields
      .map((f, i) => i)
      .filter((i) => !used.has(i))
      .filter((i) => {
        const def = fields[i]!.def;
        if (expect.label && def.label.trim() !== expect.label) return false;
        if (expect.label_contains && !def.label.includes(expect.label_contains)) return false;
        return true;
      });
    if (!candidates.length) {
      results.push({ kind: 'state', name: `字段「${label}」`, pass: false, detail: '不存在' });
      continue;
    }
    let best: { index: number; problems: string[] } | undefined;
    for (const i of candidates) {
      const problems = checkField(fields, i, expect);
      if (!best || problems.length < best.problems.length) best = { index: i, problems };
      if (!problems.length) break;
    }
    used.add(best!.index);
    results.push({
      kind: 'state',
      name: `字段「${label}」`,
      pass: best!.problems.length === 0,
      detail: best!.problems.join('；') || `${fields[best!.index]!.def.label} (${fields[best!.index]!.def.type})`
    });
  }
  return results;
}

function settingMatches(setting: Record<string, unknown>, key: string, expected: unknown): boolean {
  const actual = setting[key];
  if (key === 'success_message') {
    const want = String(expected);
    return (
      stripHtml(String(actual ?? '')).includes(want) ||
      stripHtml(String(setting.success_message_rich_text ?? '')).includes(want)
    );
  }
  if (typeof expected === 'string') return String(actual ?? '').trim() === expected.trim();
  if (typeof expected === 'number') return Number(actual) === expected;
  if (typeof expected === 'boolean') return !!actual === expected;
  return JSON.stringify(actual ?? null) === JSON.stringify(expected ?? null);
}

function toApiFilters(ctx: AssertContext, alias: string, filters: TaskFilter[] | undefined): TaskFilter[] | undefined {
  if (!filters) return undefined;
  const form = ctx.state.forms[alias]!;
  return filters.map((f) => ({ ...f, field: form.fields[f.field]?.api_code ?? f.field }));
}

async function runStateCheck(
  ctx: AssertContext,
  task: Task,
  check: StateCheck,
  trace: AgentTrace
): Promise<AssertionResult[]> {
  const { api, state } = ctx;
  const name = `${check.check}${'fixture' in check ? `(${check.fixture})` : ''}`;
  switch (check.check) {
    case 'entry_count': {
      const form = state.forms[check.fixture]!;
      const n = await api.countEntries(form.token, {
        filters: toApiFilters(ctx, check.fixture, check.filters),
        keyword: check.keyword
      });
      const problems: string[] = [];
      if (check.equals !== undefined && n !== check.equals) problems.push(`期望 ${check.equals}`);
      if (check.min !== undefined && n < check.min) problems.push(`至少 ${check.min}`);
      if (check.max !== undefined && n > check.max) problems.push(`至多 ${check.max}`);
      return [
        {
          kind: 'state',
          name,
          pass: !problems.length,
          detail: `实际 ${n} 条${problems.length ? '，' + problems.join('，') : ''}`
        }
      ];
    }
    case 'entries_match': {
      const form = state.forms[check.fixture]!;
      const rows = await api.listAllEntries(form.token, { filters: toApiFilters(ctx, check.fixture, check.filters) });
      const problems: string[] = [];
      if ((check.min ?? 1) > rows.length) problems.push(`匹配 ${rows.length} 条，至少 ${check.min ?? 1}`);
      for (const [key, expected] of Object.entries(check.all ?? {})) {
        const code = form.fields[key]!.api_code;
        const bad = rows.filter((r) => !sameValue(r[code], expected));
        if (bad.length)
          problems.push(
            `${key} 应为 ${JSON.stringify(expected)}，有 ${bad.length} 条不符（如 ${JSON.stringify(bad[0]![code] ?? null)}）`
          );
      }
      for (const [key, expected] of Object.entries(check.none ?? {})) {
        const code = form.fields[key]!.api_code;
        const hit = rows.filter((r) => sameValue(r[code], expected));
        if (hit.length) problems.push(`${key} 不应为 ${JSON.stringify(expected)}，有 ${hit.length} 条`);
      }
      return [{ kind: 'state', name, pass: !problems.length, detail: problems.join('；') || `匹配 ${rows.length} 条` }];
    }
    case 'form_created': {
      const keyword = check.name ?? check.name_contains ?? '';
      const matches = (n: string) => (check.name ? n.trim() === check.name : n.includes(keyword));
      // 先按本次运行自己的建表单工具返回的 token 定位（后建的优先）：
      // 并发运行时同名表单可能是别的模型建的，按名字搜「运行期间最新的」会串。
      const ownTokens = [...new Set(trace.calls.map((c) => c.form_token).filter((t): t is string => !!t))].toReversed();
      let form: FormDetail | undefined;
      const ownNames: string[] = [];
      for (const token of ownTokens) {
        const candidate = await api.getForm(token).catch(() => undefined);
        if (!candidate) continue;
        if (matches(candidate.name)) {
          form = candidate;
          break;
        }
        ownNames.push(candidate.name);
      }
      if (!form && !ownTokens.length) {
        // 没记录到 token（工具结果格式不认识）时才退回按名字搜运行期间最新的
        const rows = await api.listForms({
          q: keyword || undefined,
          sort: [{ field: 'created_at', order: 'desc' }],
          limit: 30
        });
        const since = ctx.runStartedAt.getTime() - 120_000;
        const hit = rows.filter((r) => Date.parse(r.created_at) >= since).find((r) => matches(r.name));
        if (hit) form = await api.getForm(hit.token);
      }
      if (!form) {
        const detail = ownNames.length
          ? `本次运行创建的表单叫「${ownNames.join('」「')}」，不是「${keyword}」`
          : `运行期间没有创建名为「${keyword}」的表单`;
        return [{ kind: 'state', name, pass: false, detail }];
      }
      const results: AssertionResult[] = [
        { kind: 'state', name: `${name}：表单存在`, pass: true, detail: `${form.name} ${form.token}` }
      ];
      const fieldCount = form.fields.length;
      if (check.min_fields !== undefined || check.max_fields !== undefined) {
        const ok =
          (check.min_fields === undefined || fieldCount >= check.min_fields) &&
          (check.max_fields === undefined || fieldCount <= check.max_fields);
        results.push({ kind: 'state', name: `${name}：字段数`, pass: ok, detail: `${fieldCount} 个` });
      }
      if (check.same_field_count_as) {
        const source = await api.getForm(state.forms[check.same_field_count_as]!.token);
        results.push({
          kind: 'state',
          name: `${name}：字段数与 ${check.same_field_count_as} 一致`,
          pass: fieldCount === source.fields.length,
          detail: `${fieldCount} vs ${source.fields.length}`
        });
      }
      if (check.scene) {
        const setting = await api.sceneSetting(check.scene, form.token);
        results.push({
          kind: 'state',
          name: `${name}：场景 ${check.scene}`,
          pass: setting !== undefined,
          detail: setting ? '是' : '不是该场景'
        });
        const expected = check.scene === 'exam' ? check.exam_setting : check.evaluation_setting;
        for (const [k, v] of Object.entries(expected ?? {})) {
          const actual = setting?.[k];
          results.push({
            kind: 'state',
            name: `${name}：${check.scene}_setting.${k}`,
            pass: settingMatches(setting ?? {}, k, v),
            detail: `实际 ${JSON.stringify(actual ?? null)}`
          });
        }
      }
      for (const [k, v] of Object.entries(check.setting ?? {})) {
        results.push({
          kind: 'state',
          name: `${name}：setting.${k}`,
          pass: settingMatches(form.setting ?? {}, k, v),
          detail: `实际 ${JSON.stringify(form.setting?.[k] ?? null)}`
        });
      }
      if (check.fields?.length)
        results.push(...matchFields(form, check.fields).map((r) => ({ ...r, name: `${name}：${r.name}` })));
      return results;
    }
    case 'form_field': {
      const seeded = state.forms[check.fixture]!;
      const form = await api.getForm(seeded.token);
      const fields = flattenFields(form);
      const index = fields.findIndex(({ def }) =>
        check.label
          ? def.label.trim() === check.label
          : check.label_contains
            ? def.label.includes(check.label_contains)
            : false
      );
      const label = check.label ?? check.label_contains ?? '';
      if (check.absent) {
        return [
          {
            kind: 'state',
            name: `${name}：字段「${label}」已删除`,
            pass: index < 0,
            detail: index < 0 ? '不存在' : '仍然存在'
          }
        ];
      }
      if (index < 0) return [{ kind: 'state', name: `${name}：字段「${label}」`, pass: false, detail: '不存在' }];
      const problems = checkField(fields, index, check);
      return [
        {
          kind: 'state',
          name: `${name}：字段「${label}」`,
          pass: !problems.length,
          detail: problems.join('；') || `${fields[index]!.def.type}`
        }
      ];
    }
    case 'form_props': {
      const seeded = state.forms[check.fixture]!;
      const form = await api.getForm(seeded.token, { theme: !!check.theme });
      const results: AssertionResult[] = [];
      if (check.name !== undefined)
        results.push({
          kind: 'state',
          name: `${name}：名称`,
          pass: form.name.trim() === check.name,
          detail: form.name
        });
      if (check.name_contains !== undefined)
        results.push({
          kind: 'state',
          name: `${name}：名称包含`,
          pass: form.name.includes(check.name_contains),
          detail: form.name
        });
      if (check.description_contains !== undefined) {
        const desc = stripHtml(form.description);
        results.push({
          kind: 'state',
          name: `${name}：描述`,
          pass: desc.includes(check.description_contains),
          detail: desc.slice(0, 80)
        });
      }
      if (check.field_count !== undefined)
        results.push({
          kind: 'state',
          name: `${name}：字段数`,
          pass: form.fields.length === check.field_count,
          detail: `${form.fields.length}`
        });
      for (const [k, v] of Object.entries(check.setting ?? {})) {
        results.push({
          kind: 'state',
          name: `${name}：setting.${k}`,
          pass: settingMatches(form.setting ?? {}, k, v),
          detail: `实际 ${JSON.stringify(form.setting?.[k] ?? null)}`
        });
      }
      for (const [k, v] of Object.entries(check.theme ?? {})) {
        const actual = form.theme?.[k];
        const ok =
          typeof v === 'string'
            ? String(actual ?? '').toLowerCase() === v.toLowerCase()
            : JSON.stringify(actual) === JSON.stringify(v);
        results.push({
          kind: 'state',
          name: `${name}：theme.${k}`,
          pass: ok,
          detail: `实际 ${JSON.stringify(actual ?? null)}`
        });
      }
      return results;
    }
    default:
      return [{ kind: 'state', name, pass: false, detail: `未知的 check：${JSON.stringify(check)}` }];
  }
}

export async function evaluateTask(task: Task, trace: AgentTrace, ctx: AssertContext): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  const expect = task.expect;
  const called = new Set(trace.calls.map((c) => c.name));
  const tpl = new Templates(ctx.api, ctx.state);

  // 工具
  for (const t of expect.tools?.must_call ?? []) {
    results.push({ kind: 'tools', name: `应调用 ${t}`, pass: called.has(t) });
  }
  if (expect.tools?.any_of?.length) {
    const hit = expect.tools.any_of.filter((t) => called.has(t));
    results.push({
      kind: 'tools',
      name: `应调用 ${expect.tools.any_of.join(' / ')} 之一`,
      pass: hit.length > 0,
      detail: hit.join(', ') || '都没调用'
    });
  }
  for (const t of expect.tools?.must_not_call ?? []) {
    results.push({ kind: 'tools', name: `不应调用 ${t}`, pass: !called.has(t) });
  }

  // 轮次
  const maxTurns = expect.max_turns ?? task.max_turns ?? 12;
  results.push({
    kind: 'turns',
    name: `轮次 ≤ ${maxTurns}`,
    pass: !trace.exhausted && trace.turns <= maxTurns,
    detail: `${trace.turns} 轮${trace.exhausted ? '，未完成' : ''}`
  });
  if (expect.max_tool_calls !== undefined) {
    results.push({
      kind: 'turns',
      name: `工具调用 ≤ ${expect.max_tool_calls}`,
      pass: trace.tool_calls <= expect.max_tool_calls,
      detail: `${trace.tool_calls} 次`
    });
  }
  if (trace.error) results.push({ kind: 'turns', name: '运行无错误', pass: false, detail: trace.error });

  // 答复
  const answer = trace.final_answer ?? '';
  const norm = normalize(answer);
  const a = expect.answer;
  if (a) {
    if (!answer.trim()) {
      results.push({ kind: 'answer', name: '有最终答复', pass: false, detail: '为空' });
    }
    for (const raw of a.contains ?? []) {
      const s = await tpl.render(String(raw));
      results.push({ kind: 'answer', name: `答复含「${s}」`, pass: norm.includes(normalize(s)) });
    }
    if (a.contains_any?.length) {
      const rendered = await Promise.all(a.contains_any.map((s) => tpl.render(String(s))));
      const hit = rendered.filter((s) => norm.includes(normalize(s)));
      results.push({
        kind: 'answer',
        name: `答复含 ${rendered.map((s) => `「${s}」`).join(' / ')} 之一`,
        pass: hit.length > 0
      });
    }
    for (const raw of a.not_contains ?? []) {
      const s = await tpl.render(String(raw));
      results.push({ kind: 'answer', name: `答复不含「${s}」`, pass: !norm.includes(normalize(s)) });
    }
    if (a.regex) {
      results.push({ kind: 'answer', name: `答复匹配 /${a.regex}/`, pass: new RegExp(a.regex, 'i').test(answer) });
    }
    if (a.claims?.length) {
      const claims = await Promise.all(a.claims.map((c) => tpl.render(c)));
      try {
        const verdicts = await judgeClaims(ctx.llm, ctx.judgeModel, { prompt: task.prompt, answer, claims });
        for (const v of verdicts) results.push({ kind: 'claim', name: v.claim, pass: v.pass, detail: v.reason });
      } catch (error) {
        for (const c of claims)
          results.push({ kind: 'claim', name: c, pass: false, detail: `judge 失败：${(error as Error).message}` });
      }
    }
  }

  // 状态
  for (const check of expect.state ?? []) {
    try {
      results.push(...(await runStateCheck(ctx, task, check, trace)));
    } catch (error) {
      results.push({ kind: 'state', name: check.check, pass: false, detail: `检查出错：${(error as Error).message}` });
    }
  }
  return results;
}
