/**
 * 夹具：按 fixtures.yaml 在测评账户里建表单、灌数据、重置。状态记在 state/fixtures.json。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { EVALS_DIR, type EvalConfig } from './config.js';
import { EvalApi, flattenFields, type FieldDef, type FormDetail } from './api.js';
import type { FixtureField, FixtureForm, FixtureState, FixturesSpec, SeededForm } from './types.js';

export function loadFixturesSpec(path = resolve(EVALS_DIR, 'fixtures.yaml')): FixturesSpec {
  const spec = parse(readFileSync(path, 'utf8')) as FixturesSpec;
  const seen = new Set<string>();
  for (const form of spec.forms) {
    if (seen.has(form.alias)) throw new Error(`fixtures.yaml：alias 重复 ${form.alias}`);
    seen.add(form.alias);
    const labels = new Set<string>();
    for (const f of form.fields) {
      if (labels.has(f.label)) throw new Error(`fixtures.yaml：${form.alias} 字段标题重复 ${f.label}`);
      labels.add(f.label);
    }
    for (const [i, entry] of (form.entries ?? []).entries()) {
      for (const key of Object.keys(entry)) {
        if (!form.fields.some((f) => f.key === key))
          throw new Error(`fixtures.yaml：${form.alias} 第 ${i + 1} 条数据的键 ${key} 不是字段`);
      }
    }
  }
  return spec;
}

export function statePath(cfg: EvalConfig): string {
  return resolve(cfg.stateDir, 'fixtures.json');
}

export function loadState(cfg: EvalConfig): FixtureState | undefined {
  const path = statePath(cfg);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureState;
}

export function saveState(cfg: EvalConfig, state: FixtureState): void {
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(statePath(cfg), `${JSON.stringify(state, null, 2)}\n`);
}

export function requireState(cfg: EvalConfig): FixtureState {
  const state = loadState(cfg);
  if (!state) throw new Error('还没有夹具状态：先运行 `npm run eval -- seed`。');
  return state;
}

const stripHtml = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

const UNIQUE_TYPES = new Set(['TextField', 'NameField', 'EmailField', 'MobileField', 'TextArea', 'NumberField']);

/** 夹具字段 → FieldInput */
export function toFieldInput(f: FixtureField): Record<string, unknown> {
  const input: Record<string, unknown> = { type: f.type, label: f.label };
  if (f.required) input.required = true;
  if (f.unique && UNIQUE_TYPES.has(f.type)) input.unique = true;
  if (f.notes) input.notes = f.notes;
  if (f.choices) input.choices = f.choices.map((value) => ({ value }));
  if (f.precision) input.precision = f.precision;
  if (f.rating_max) input.rating_max = f.rating_max;
  return input;
}

/** 夹具数据（按 key）→ 写入 API 的数据（按 api_code） */
export function toEntryInput(seeded: SeededForm, entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    const field = seeded.fields[key];
    if (!field) throw new Error(`夹具 ${seeded.alias} 没有字段 ${key}`);
    out[field.api_code] = value;
  }
  return out;
}

function mapFields(spec: FixtureForm, form: FormDetail): SeededForm['fields'] {
  const byLabel = new Map(flattenFields(form).map(({ api_code, def }) => [def.label, { api_code, def }]));
  const fields: SeededForm['fields'] = {};
  for (const f of spec.fields) {
    const hit = byLabel.get(f.label);
    if (!hit) throw new Error(`表单 ${spec.name} 里找不到字段「${f.label}」`);
    fields[f.key] = { api_code: hit.api_code, type: hit.def.type, label: f.label };
  }
  return fields;
}

export interface SeedOptions {
  /** 即使数据条数一致也重灌 */
  reset?: boolean;
  log?: (line: string) => void;
}

async function ensureFolder(api: EvalApi, name: string, log: (s: string) => void): Promise<string> {
  const folders = await api.listFolders();
  const hit = folders.find((f) => f.name === name && f.kind === 'form');
  if (hit) return hit.token;
  const created = await api.createFolder(name, 'form');
  log(`创建文件夹「${name}」 ${created.token}`);
  return created.token;
}

async function findFormByName(api: EvalApi, name: string, preferToken?: string) {
  const rows = await api.listForms({ filters: [{ field: 'form_name', operator: 'eq', value: name }], limit: 50 });
  const exact = rows.filter((r) => r.name === name);
  if (preferToken) {
    const kept = exact.find((r) => r.token === preferToken);
    if (kept) return kept;
  }
  // 多个同名时取最早创建的那个（夹具最先建）
  return exact.sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
}

/** 读到的值与夹具值是否一致（选项按显示值，日期按日，数字按数值） */
export function sameValue(actual: unknown, expected: unknown): boolean {
  if (expected === undefined || expected === null || expected === '') {
    return actual === undefined || actual === null || actual === '' || (Array.isArray(actual) && actual.length === 0);
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    const a = [...actual].map(String).sort();
    const b = [...expected].map(String).sort();
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  if (typeof expected === 'number') return Number(actual) === expected;
  const e = String(expected);
  const a = actual === undefined || actual === null ? '' : String(actual);
  if (/^\d{4}-\d{2}-\d{2}$/.test(e)) return a.startsWith(e) || a.replace(/\//g, '-').startsWith(e);
  return a === e;
}

export async function seed(
  api: EvalApi,
  cfg: EvalConfig,
  spec: FixturesSpec,
  options: SeedOptions = {}
): Promise<FixtureState> {
  const log = options.log ?? (() => {});
  const previous = loadState(cfg);
  const me = await api.me();
  const billing = await api.billingAccount();
  log(`账户：${me.name} <${me.email}> / ${billing.name}`);

  const folderToken = await ensureFolder(api, spec.folder, log);
  const outputFolderToken = await ensureFolder(api, spec.output_folder, log);

  const state: FixtureState = {
    account: {
      user_id: me.id,
      user_name: me.name,
      billing_account_id: me.billing_account_id,
      billing_account_name: billing.name
    },
    api_base_url: api.api.baseUrl,
    folder_token: folderToken,
    output_folder_token: outputFolderToken,
    seeded_at: new Date().toISOString(),
    forms: {},
    results_form_token: previous?.results_form_token
  };

  for (const formSpec of spec.forms) {
    const existing = await findFormByName(api, formSpec.name, previous?.forms[formSpec.alias]?.token);
    let detail: FormDetail;
    if (existing) {
      detail = await api.getForm(existing.token, { theme: true });
      log(`复用表单「${formSpec.name}」 ${existing.token}`);
    } else {
      detail = await api.createForm({
        name: formSpec.name,
        description: formSpec.description,
        fields: formSpec.fields.map(toFieldInput),
        folder_token: folderToken,
        ...(formSpec.setting ? { setting: formSpec.setting } : {})
      });
      detail = await api.getForm(detail.token, { theme: true });
      log(`创建表单「${formSpec.name}」 ${detail.token}`);
    }
    const seeded: SeededForm = {
      alias: formSpec.alias,
      name: formSpec.name,
      token: detail.token,
      url: detail.url,
      fields: mapFields(formSpec, detail),
      seed_serials: previous?.forms[formSpec.alias]?.seed_serials ?? [],
      theme_primary_color:
        previous?.forms[formSpec.alias]?.theme_primary_color ?? (detail.theme?.primary_color as string | undefined)
    };
    state.forms[formSpec.alias] = seeded;
    // 结构与设置对齐（复用的表单可能被上次评测改过）
    await resetStructure(api, formSpec, seeded, log);
    // 数据
    const wanted = formSpec.entries ?? [];
    const current = await api.listAllEntries(seeded.token);
    const needReseed =
      options.reset ||
      current.length !== wanted.length ||
      seeded.seed_serials.length !== wanted.length ||
      !wanted.every((row, i) => {
        const found = current.find((e) => e.serial_number === seeded.seed_serials[i]);
        return found && Object.entries(row).every(([k, v]) => sameValue(found[seeded.fields[k]!.api_code], v));
      });
    if (needReseed) {
      for (const e of current) await api.deleteEntry(seeded.token, e.serial_number);
      if (wanted.length) {
        await api.createEntriesBatch(
          seeded.token,
          wanted.map((row) => toEntryInput(seeded, row))
        );
      }
      const after = await api.listAllEntries(seeded.token);
      if (after.length !== wanted.length) {
        throw new Error(`表单「${formSpec.name}」灌数据后有 ${after.length} 条，期望 ${wanted.length} 条`);
      }
      seeded.seed_serials = after.map((e) => e.serial_number).sort((a, b) => a - b);
      log(`  数据重置：${wanted.length} 条`);
    } else {
      log(`  数据一致：${wanted.length} 条`);
    }
  }
  saveState(cfg, state);
  return state;
}

/** 把表单结构 / 设置 / 主题恢复成夹具描述；只在有差异时发请求。 */
export async function resetStructure(
  api: EvalApi,
  spec: FixtureForm,
  seeded: SeededForm,
  log: (s: string) => void = () => {}
): Promise<void> {
  let form = await api.getForm(seeded.token, { theme: true });
  const current = flattenFields(form);
  const specLabels = new Set(spec.fields.map((f) => f.label));
  const ops: { add?: unknown[]; remove?: string[]; update?: unknown[]; update_choices?: unknown[] } = {};

  // 多出来的字段删掉；缺的字段补回
  const extra = current.filter(({ def }) => !specLabels.has(def.label)).map(({ api_code }) => api_code);
  if (extra.length) ops.remove = extra;
  const missing = spec.fields.filter((f) => !current.some(({ def }) => def.label === f.label));
  if (missing.length) ops.add = missing.map(toFieldInput);

  for (const f of spec.fields) {
    const hit = current.find(({ def }) => def.label === f.label);
    if (!hit) continue;
    const validation = (hit.def.validation ?? {}) as Record<string, unknown>;
    const update: Record<string, unknown> = { api_code: hit.api_code };
    if (!!validation.required !== !!f.required) update.required = !!f.required;
    if (UNIQUE_TYPES.has(f.type) && !!validation.unique !== !!f.unique) update.unique = !!f.unique;
    if (Object.keys(update).length > 1) (ops.update ??= []).push(update);
    if (f.choices) {
      const names = (hit.def.choices ?? []).filter((c) => !c.hidden).map((c) => c.name);
      const removeChoices = (hit.def.choices ?? []).filter((c) => !f.choices!.includes(c.name)).map((c) => c.value);
      const addChoices = f.choices.filter((c) => !names.includes(c)).map((value) => ({ value }));
      if (removeChoices.length || addChoices.length) {
        (ops.update_choices ??= []).push({
          field_api_code: hit.api_code,
          ...(removeChoices.length ? { remove: removeChoices } : {}),
          ...(addChoices.length ? { add: addChoices } : {})
        });
      }
    }
  }

  const body: Record<string, unknown> = {};
  if (form.name !== spec.name) body.name = spec.name;
  const desc = spec.description ?? '';
  if ((form.description ?? '').replace(/<[^>]+>/g, '').trim() !== desc.trim()) body.description = desc;
  if (Object.keys(ops).length) body.fields = ops;
  if (Object.keys(body).length) {
    form = await api.updateForm(seeded.token, body);
    log(`  结构恢复：${Object.keys(body).join(' / ')}`);
    // 字段可能被重建，刷新 api_code 映射
    seeded.fields = mapFields(spec, form);
  }

  // 设置只在夹具声明了 setting 时对齐（其它表单保持服务端缺省）；填写密码任何时候都清掉
  const setting = (form.setting ?? {}) as Record<string, unknown>;
  const diff: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec.setting ?? {})) {
    if (k === 'success_message') {
      if (stripHtml(String(setting.success_message ?? '')) !== String(v)) diff[k] = v;
    } else if (JSON.stringify(setting[k] ?? null) !== JSON.stringify(v ?? null)) diff[k] = v;
  }
  // 填写密码只能用空串清除（null 会被服务端拒绝）
  if (setting.access_password) diff.access_password = '';
  if (Object.keys(diff).length) {
    await api.updateFormSetting(seeded.token, diff);
    log(`  设置恢复：${Object.keys(diff).join(' / ')}`);
  }

  const primary = form.theme?.primary_color as string | undefined;
  if (seeded.theme_primary_color && primary && primary.toLowerCase() !== seeded.theme_primary_color.toLowerCase()) {
    await api.updateTheme(seeded.token, { primary_color: seeded.theme_primary_color });
    log(`  主题恢复：primary_color`);
  }
}

/** 把一个夹具的数据恢复成种子：删多余、补缺失、改回被改动的值。 */
export async function resetEntries(
  api: EvalApi,
  spec: FixtureForm,
  seeded: SeededForm,
  log: (s: string) => void = () => {}
): Promise<void> {
  const wanted = spec.entries ?? [];
  const current = await api.listAllEntries(seeded.token);
  const seedSet = new Set(seeded.seed_serials);
  let changed = 0;
  for (const e of current) {
    if (!seedSet.has(e.serial_number)) {
      await api.deleteEntry(seeded.token, e.serial_number);
      changed++;
    }
  }
  const missingRows: Record<string, unknown>[] = [];
  const newSerials: number[] = [];
  for (const [i, row] of wanted.entries()) {
    const serial = seeded.seed_serials[i];
    const found = serial === undefined ? undefined : current.find((e) => e.serial_number === serial);
    if (!found) {
      missingRows.push(row);
      continue;
    }
    newSerials.push(serial!);
    const patch: Record<string, unknown> = {};
    for (const f of spec.fields) {
      const expected = row[f.key];
      if (!sameValue(found[seeded.fields[f.key]!.api_code], expected)) {
        patch[seeded.fields[f.key]!.api_code] = expected ?? (f.choices && f.type === 'CheckBox' ? [] : '');
      }
    }
    if (Object.keys(patch).length) {
      await api.updateEntry(seeded.token, serial!, patch);
      changed++;
    }
  }
  if (missingRows.length) {
    await api.createEntriesBatch(
      seeded.token,
      missingRows.map((row) => toEntryInput(seeded, row))
    );
    const after = await api.listAllEntries(seeded.token);
    const known = new Set(newSerials);
    const added = after.map((e) => e.serial_number).filter((s) => !known.has(s));
    newSerials.push(...added);
    changed += missingRows.length;
  }
  seeded.seed_serials = newSerials.sort((a, b) => a - b);
  if (changed) log(`  ${spec.alias} 数据重置：${changed} 处`);
}

/** 运行前后把夹具整体恢复（结构 + 数据），并把状态写回。 */
export async function resetFixture(
  api: EvalApi,
  cfg: EvalConfig,
  spec: FixturesSpec,
  state: FixtureState,
  alias: string,
  log?: (s: string) => void
): Promise<void> {
  const formSpec = spec.forms.find((f) => f.alias === alias);
  const seeded = state.forms[alias];
  if (!formSpec || !seeded) throw new Error(`没有夹具 ${alias}`);
  await resetStructure(api, formSpec, seeded, log);
  await resetEntries(api, formSpec, seeded, log);
  saveState(cfg, state);
}

/** 把评测期间新建的表单（不属于夹具）移入产出文件夹，返回移动的表单。 */
export async function sweepCreatedForms(
  api: EvalApi,
  state: FixtureState,
  since: Date,
  log: (s: string) => void = () => {}
): Promise<{ token: string; name: string }[]> {
  const fixtureTokens = new Set(Object.values(state.forms).map((f) => f.token));
  if (state.results_form_token) fixtureTokens.add(state.results_form_token);
  const rows = await api.listForms({ sort: [{ field: 'created_at', order: 'desc' }], limit: 100 });
  const moved: { token: string; name: string }[] = [];
  for (const row of rows) {
    if (fixtureTokens.has(row.token)) continue;
    if (Date.parse(row.created_at) < since.getTime() - 60_000) break;
    try {
      await api.moveFormToFolder(row.token, state.output_folder_token);
      moved.push({ token: row.token, name: row.name });
    } catch (error) {
      log(`  移动表单 ${row.token} 失败：${(error as Error).message}`);
    }
  }
  if (moved.length) log(`  新建表单 ${moved.length} 个已移入「产出」文件夹`);
  return moved;
}

export type { FieldDef };
