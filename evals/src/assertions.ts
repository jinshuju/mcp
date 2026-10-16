/**
 * Assertions: the tool-call sequence, turns, the final answer (substrings / regex / LLM judge) and the real state after the run (read back through the API).
 * A task passes when every assertion passes. Expected values (labels, answer strings, claims) come from the task files and stay as written.
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

/** Normalizes full-width digits / commas in an answer, for substring matching */
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
      if (value === undefined) throw new Error(`Cannot resolve template ${whole}`);
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
  if (!fieldTypeOk(def, expect)) problems.push(`type is ${def.type}, expected ${[expect.type].flat().join('/')}`);
  const validation = (def.validation ?? {}) as Record<string, unknown>;
  if (expect.required !== undefined && !!validation.required !== expect.required) {
    problems.push(expect.required ? 'not required' : 'should not be required');
  }
  if (expect.unique !== undefined && !!validation.unique !== expect.unique) {
    problems.push(expect.unique ? 'not set to unique' : 'should not be unique');
  }
  const names = (def.choices ?? []).filter((c) => !c.hidden).map((c) => c.name);
  if (expect.choices !== undefined && names.length !== expect.choices) {
    problems.push(`${names.length} choices, expected ${expect.choices}`);
  }
  if (expect.choices_min !== undefined && names.length < expect.choices_min) {
    problems.push(`${names.length} choices, expected at least ${expect.choices_min}`);
  }
  for (const want of expect.choices_include ?? []) {
    if (!names.some((n) => n.trim() === want)) problems.push(`missing choice "${want}"`);
  }
  if (expect.after_label) {
    const anchor = fields.findIndex(({ def: d }) => d.label === expect.after_label);
    if (anchor < 0) problems.push(`no anchor field "${expect.after_label}"`);
    else if (index !== anchor + 1) problems.push(`not right after "${expect.after_label}"`);
  }
  return problems;
}

/** Finds a field that meets each expectation; each expectation in fields matches a different field. */
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
      results.push({ kind: 'state', name: `field "${label}"`, pass: false, detail: 'does not exist' });
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
      name: `field "${label}"`,
      pass: best!.problems.length === 0,
      detail: best!.problems.join('; ') || `${fields[best!.index]!.def.label} (${fields[best!.index]!.def.type})`
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

async function runStateCheck(ctx: AssertContext, task: Task, check: StateCheck): Promise<AssertionResult[]> {
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
      if (check.equals !== undefined && n !== check.equals) problems.push(`expected ${check.equals}`);
      if (check.min !== undefined && n < check.min) problems.push(`at least ${check.min}`);
      if (check.max !== undefined && n > check.max) problems.push(`at most ${check.max}`);
      return [
        {
          kind: 'state',
          name,
          pass: !problems.length,
          detail: `actually ${n}${problems.length ? ', ' + problems.join(', ') : ''}`
        }
      ];
    }
    case 'entries_match': {
      const form = state.forms[check.fixture]!;
      const rows = await api.listAllEntries(form.token, { filters: toApiFilters(ctx, check.fixture, check.filters) });
      const problems: string[] = [];
      if ((check.min ?? 1) > rows.length) problems.push(`${rows.length} match, expected at least ${check.min ?? 1}`);
      for (const [key, expected] of Object.entries(check.all ?? {})) {
        const code = form.fields[key]!.api_code;
        const bad = rows.filter((r) => !sameValue(r[code], expected));
        if (bad.length)
          problems.push(
            `${key} should be ${JSON.stringify(expected)}; ${bad.length} entries differ (e.g. ${JSON.stringify(bad[0]![code] ?? null)})`
          );
      }
      for (const [key, expected] of Object.entries(check.none ?? {})) {
        const code = form.fields[key]!.api_code;
        const hit = rows.filter((r) => sameValue(r[code], expected));
        if (hit.length) problems.push(`${key} should not be ${JSON.stringify(expected)}; ${hit.length} entries are`);
      }
      return [{ kind: 'state', name, pass: !problems.length, detail: problems.join('; ') || `${rows.length} match` }];
    }
    case 'form_created': {
      const keyword = check.name ?? check.name_contains ?? '';
      const rows = await api.listForms({
        q: keyword || undefined,
        sort: [{ field: 'created_at', order: 'desc' }],
        limit: 30
      });
      const since = ctx.runStartedAt.getTime() - 120_000;
      const hits = rows
        .filter((r) => Date.parse(r.created_at) >= since)
        .filter((r) => (check.name ? r.name.trim() === check.name : r.name.includes(keyword)));
      if (!hits.length) {
        return [{ kind: 'state', name, pass: false, detail: `no form named "${keyword}" was created during the run` }];
      }
      const form = await api.getForm(hits[0]!.token);
      const results: AssertionResult[] = [
        { kind: 'state', name: `${name}: form exists`, pass: true, detail: `${form.name} ${form.token}` }
      ];
      const fieldCount = form.fields.length;
      if (check.min_fields !== undefined || check.max_fields !== undefined) {
        const ok =
          (check.min_fields === undefined || fieldCount >= check.min_fields) &&
          (check.max_fields === undefined || fieldCount <= check.max_fields);
        results.push({ kind: 'state', name: `${name}: field count`, pass: ok, detail: `${fieldCount}` });
      }
      if (check.same_field_count_as) {
        const source = await api.getForm(state.forms[check.same_field_count_as]!.token);
        results.push({
          kind: 'state',
          name: `${name}: same field count as ${check.same_field_count_as}`,
          pass: fieldCount === source.fields.length,
          detail: `${fieldCount} vs ${source.fields.length}`
        });
      }
      if (check.scene) {
        const setting = await api.sceneSetting(check.scene, form.token);
        results.push({
          kind: 'state',
          name: `${name}: scene ${check.scene}`,
          pass: setting !== undefined,
          detail: setting ? 'yes' : 'another scene'
        });
        const expected = check.scene === 'exam' ? check.exam_setting : check.evaluation_setting;
        for (const [k, v] of Object.entries(expected ?? {})) {
          const actual = setting?.[k];
          results.push({
            kind: 'state',
            name: `${name}: ${check.scene}_setting.${k}`,
            pass: settingMatches(setting ?? {}, k, v),
            detail: `actually ${JSON.stringify(actual ?? null)}`
          });
        }
      }
      for (const [k, v] of Object.entries(check.setting ?? {})) {
        results.push({
          kind: 'state',
          name: `${name}: setting.${k}`,
          pass: settingMatches(form.setting ?? {}, k, v),
          detail: `actually ${JSON.stringify(form.setting?.[k] ?? null)}`
        });
      }
      if (check.fields?.length)
        results.push(...matchFields(form, check.fields).map((r) => ({ ...r, name: `${name}: ${r.name}` })));
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
            name: `${name}: field "${label}" removed`,
            pass: index < 0,
            detail: index < 0 ? 'does not exist' : 'still exists'
          }
        ];
      }
      if (index < 0)
        return [{ kind: 'state', name: `${name}: field "${label}"`, pass: false, detail: 'does not exist' }];
      const problems = checkField(fields, index, check);
      return [
        {
          kind: 'state',
          name: `${name}: field "${label}"`,
          pass: !problems.length,
          detail: problems.join('; ') || `${fields[index]!.def.type}`
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
          name: `${name}: name`,
          pass: form.name.trim() === check.name,
          detail: form.name
        });
      if (check.name_contains !== undefined)
        results.push({
          kind: 'state',
          name: `${name}: name contains`,
          pass: form.name.includes(check.name_contains),
          detail: form.name
        });
      if (check.description_contains !== undefined) {
        const desc = stripHtml(form.description);
        results.push({
          kind: 'state',
          name: `${name}: description`,
          pass: desc.includes(check.description_contains),
          detail: desc.slice(0, 80)
        });
      }
      if (check.field_count !== undefined)
        results.push({
          kind: 'state',
          name: `${name}: field count`,
          pass: form.fields.length === check.field_count,
          detail: `${form.fields.length}`
        });
      for (const [k, v] of Object.entries(check.setting ?? {})) {
        results.push({
          kind: 'state',
          name: `${name}: setting.${k}`,
          pass: settingMatches(form.setting ?? {}, k, v),
          detail: `actually ${JSON.stringify(form.setting?.[k] ?? null)}`
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
          name: `${name}: theme.${k}`,
          pass: ok,
          detail: `actually ${JSON.stringify(actual ?? null)}`
        });
      }
      return results;
    }
    default:
      return [{ kind: 'state', name, pass: false, detail: `unknown check: ${JSON.stringify(check)}` }];
  }
}

export async function evaluateTask(task: Task, trace: AgentTrace, ctx: AssertContext): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  const expect = task.expect;
  const called = new Set(trace.calls.map((c) => c.name));
  const tpl = new Templates(ctx.api, ctx.state);

  // Tools
  for (const t of expect.tools?.must_call ?? []) {
    results.push({ kind: 'tools', name: `calls ${t}`, pass: called.has(t) });
  }
  if (expect.tools?.any_of?.length) {
    const hit = expect.tools.any_of.filter((t) => called.has(t));
    results.push({
      kind: 'tools',
      name: `calls one of ${expect.tools.any_of.join(' / ')}`,
      pass: hit.length > 0,
      detail: hit.join(', ') || 'called none'
    });
  }
  for (const t of expect.tools?.must_not_call ?? []) {
    results.push({ kind: 'tools', name: `does not call ${t}`, pass: !called.has(t) });
  }

  // Turns
  const maxTurns = expect.max_turns ?? task.max_turns ?? 12;
  results.push({
    kind: 'turns',
    name: `turns ≤ ${maxTurns}`,
    pass: !trace.exhausted && trace.turns <= maxTurns,
    detail: `${trace.turns} turns${trace.exhausted ? ', not finished' : ''}`
  });
  if (expect.max_tool_calls !== undefined) {
    results.push({
      kind: 'turns',
      name: `tool calls ≤ ${expect.max_tool_calls}`,
      pass: trace.tool_calls <= expect.max_tool_calls,
      detail: `${trace.tool_calls}`
    });
  }
  if (trace.error) results.push({ kind: 'turns', name: 'run without errors', pass: false, detail: trace.error });

  // Answer
  const answer = trace.final_answer ?? '';
  const norm = normalize(answer);
  const a = expect.answer;
  if (a) {
    if (!answer.trim()) {
      results.push({ kind: 'answer', name: 'has a final answer', pass: false, detail: 'empty' });
    }
    for (const raw of a.contains ?? []) {
      const s = await tpl.render(String(raw));
      results.push({ kind: 'answer', name: `answer contains "${s}"`, pass: norm.includes(normalize(s)) });
    }
    if (a.contains_any?.length) {
      const rendered = await Promise.all(a.contains_any.map((s) => tpl.render(String(s))));
      const hit = rendered.filter((s) => norm.includes(normalize(s)));
      results.push({
        kind: 'answer',
        name: `answer contains one of ${rendered.map((s) => `"${s}"`).join(' / ')}`,
        pass: hit.length > 0
      });
    }
    for (const raw of a.not_contains ?? []) {
      const s = await tpl.render(String(raw));
      results.push({ kind: 'answer', name: `answer does not contain "${s}"`, pass: !norm.includes(normalize(s)) });
    }
    if (a.regex) {
      results.push({
        kind: 'answer',
        name: `answer matches /${a.regex}/`,
        pass: new RegExp(a.regex, 'i').test(answer)
      });
    }
    if (a.claims?.length) {
      const claims = await Promise.all(a.claims.map((c) => tpl.render(c)));
      try {
        const verdicts = await judgeClaims(ctx.llm, ctx.judgeModel, { prompt: task.prompt, answer, claims });
        for (const v of verdicts) results.push({ kind: 'claim', name: v.claim, pass: v.pass, detail: v.reason });
      } catch (error) {
        for (const c of claims)
          results.push({ kind: 'claim', name: c, pass: false, detail: `judge failed: ${(error as Error).message}` });
      }
    }
  }

  // State
  for (const check of expect.state ?? []) {
    try {
      results.push(...(await runStateCheck(ctx, task, check)));
    } catch (error) {
      results.push({
        kind: 'state',
        name: check.check,
        pass: false,
        detail: `check failed: ${(error as Error).message}`
      });
    }
  }
  return results;
}
