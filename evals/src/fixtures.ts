/**
 * Fixtures: create forms in the eval account from fixtures.yaml, load their entries, reset them. State lives in state/fixtures.json.
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
    if (seen.has(form.alias)) throw new Error(`fixtures.yaml: duplicate alias ${form.alias}`);
    seen.add(form.alias);
    const labels = new Set<string>();
    for (const f of form.fields) {
      if (labels.has(f.label)) throw new Error(`fixtures.yaml: ${form.alias} has a duplicate field label ${f.label}`);
      labels.add(f.label);
    }
    for (const [i, entry] of (form.entries ?? []).entries()) {
      for (const key of Object.keys(entry)) {
        if (!form.fields.some((f) => f.key === key))
          throw new Error(`fixtures.yaml: ${form.alias} entry ${i + 1} has key ${key}, which is not a field`);
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
  if (!state) throw new Error('No fixture state yet: run `npm run eval -- seed` first.');
  return state;
}

const stripHtml = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

const UNIQUE_TYPES = new Set(['TextField', 'NameField', 'EmailField', 'MobileField', 'TextArea', 'NumberField']);

/** Fixture field → FieldInput */
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

/** Fixture entry (by key) → entry for the API (by api_code) */
export function toEntryInput(seeded: SeededForm, entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    const field = seeded.fields[key];
    if (!field) throw new Error(`Fixture ${seeded.alias} has no field ${key}`);
    out[field.api_code] = value;
  }
  return out;
}

function mapFields(spec: FixtureForm, form: FormDetail): SeededForm['fields'] {
  const byLabel = new Map(flattenFields(form).map(({ api_code, def }) => [def.label, { api_code, def }]));
  const fields: SeededForm['fields'] = {};
  for (const f of spec.fields) {
    const hit = byLabel.get(f.label);
    if (!hit) throw new Error(`Form ${spec.name} has no field "${f.label}"`);
    fields[f.key] = { api_code: hit.api_code, type: hit.def.type, label: f.label };
  }
  return fields;
}

export interface SeedOptions {
  /** Reload the entries even when the count already matches */
  reset?: boolean;
  log?: (line: string) => void;
}

async function ensureFolder(api: EvalApi, name: string, log: (s: string) => void): Promise<string> {
  const folders = await api.listFolders();
  const hit = folders.find((f) => f.name === name && f.kind === 'form');
  if (hit) return hit.token;
  const created = await api.createFolder(name, 'form');
  log(`Created folder "${name}" ${created.token}`);
  return created.token;
}

async function findFormByName(api: EvalApi, name: string, preferToken?: string) {
  const rows = await api.listForms({ filters: [{ field: 'form_name', operator: 'eq', value: name }], limit: 50 });
  const exact = rows.filter((r) => r.name === name);
  if (preferToken) {
    const kept = exact.find((r) => r.token === preferToken);
    if (kept) return kept;
  }
  // Several with the same name: take the oldest (the fixture was created first)
  return exact.sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
}

/** Whether a value read back equals the fixture value (choices by label, dates by day, numbers by value) */
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
  log(`Account: ${me.name} <${me.email}> / ${billing.name}`);

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
      log(`Reusing form "${formSpec.name}" ${existing.token}`);
    } else {
      detail = await api.createForm({
        name: formSpec.name,
        description: formSpec.description,
        fields: formSpec.fields.map(toFieldInput),
        folder_token: folderToken,
        ...(formSpec.setting ? { setting: formSpec.setting } : {})
      });
      detail = await api.getForm(detail.token, { theme: true });
      log(`Created form "${formSpec.name}" ${detail.token}`);
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
    // Align structure and settings (a reused form may have been changed by the last run)
    await resetStructure(api, formSpec, seeded, log);
    // Entries
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
        throw new Error(`Form "${formSpec.name}" has ${after.length} entries after loading, expected ${wanted.length}`);
      }
      seeded.seed_serials = after.map((e) => e.serial_number).sort((a, b) => a - b);
      log(`  Entries reset: ${wanted.length}`);
    } else {
      log(`  Entries match: ${wanted.length}`);
    }
  }
  saveState(cfg, state);
  return state;
}

/** Restores a form's structure / settings / theme to the fixture description; sends a request only when something differs. */
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

  // Remove extra fields; add missing ones back
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
    log(`  Structure restored: ${Object.keys(body).join(' / ')}`);
    // Fields may have been recreated: refresh the api_code map
    seeded.fields = mapFields(spec, form);
  }

  // Align settings only when the fixture declares setting (other forms keep the server defaults); always clear a fill password
  const setting = (form.setting ?? {}) as Record<string, unknown>;
  const diff: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec.setting ?? {})) {
    if (k === 'success_message') {
      if (stripHtml(String(setting.success_message ?? '')) !== String(v)) diff[k] = v;
    } else if (JSON.stringify(setting[k] ?? null) !== JSON.stringify(v ?? null)) diff[k] = v;
  }
  // A fill password is cleared only with an empty string (the server rejects null)
  if (setting.access_password) diff.access_password = '';
  if (Object.keys(diff).length) {
    await api.updateFormSetting(seeded.token, diff);
    log(`  Settings restored: ${Object.keys(diff).join(' / ')}`);
  }

  const primary = form.theme?.primary_color as string | undefined;
  if (seeded.theme_primary_color && primary && primary.toLowerCase() !== seeded.theme_primary_color.toLowerCase()) {
    await api.updateTheme(seeded.token, { primary_color: seeded.theme_primary_color });
    log(`  Theme restored: primary_color`);
  }
}

/** Restores a fixture's entries to the seed: delete extras, add missing ones, revert changed values. */
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
  if (changed) log(`  ${spec.alias} entries reset: ${changed} changes`);
}

/** Restores a whole fixture (structure + entries) before and after a run, and saves the state. */
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
  if (!formSpec || !seeded) throw new Error(`No fixture ${alias}`);
  await resetStructure(api, formSpec, seeded, log);
  await resetEntries(api, formSpec, seeded, log);
  saveState(cfg, state);
}

/** Moves forms created during the run (not fixtures) into the output folder; returns the forms moved. */
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
      log(`  Moving form ${row.token} failed: ${(error as Error).message}`);
    }
  }
  if (moved.length) log(`  Moved ${moved.length} new forms into the output folder`);
  return moved;
}

export type { FieldDef };
