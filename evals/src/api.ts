/**
 * The eval's own API access (seed data, state assertions, resets, writing results).
 * It reuses the main package's JinshujuApi and operation table and goes through neither MCP under test, so the referee stays independent of the players.
 */
import { JinshujuApi, type ApiResponse } from '../../src/api.js';
import { OPERATIONS } from '../../src/composites.js';
import type { Credential } from '../../src/credential.js';
import type { TaskFilter } from './types.js';

export class ApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(`${operation} → HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 1000));
    this.name = 'ApiError';
  }
}

export interface FieldDef {
  label: string;
  type: string;
  api_code_alias?: string | null;
  validation?: Record<string, unknown>;
  choices?: { name: string; value: string; hidden?: boolean }[];
  [k: string]: unknown;
}

export interface FormDetail {
  name: string;
  token: string;
  url: string;
  description: string | null;
  fields: Record<string, FieldDef>[];
  setting: Record<string, unknown>;
  theme?: Record<string, unknown>;
}

export interface FormRow {
  name: string;
  token: string;
  created_at: string;
  entries_count: number;
  last_entry_created_at: string | null;
}

export type Entry = Record<string, unknown> & { serial_number: number };

export class EvalApi {
  constructor(
    readonly api: JinshujuApi,
    readonly credential: Credential
  ) {}

  /** Calls one operation by operationId; a non-2xx response throws ApiError. */
  async op<T = unknown>(operationId: string, args: Record<string, unknown> = {}): Promise<T> {
    const spec = OPERATIONS[operationId];
    if (!spec) throw new Error(`${operationId} is not in operations.json`);
    const res = await this.api.call(spec, args, this.credential);
    if (res.status < 200 || res.status >= 300) throw new ApiError(operationId, res.status, res.json ?? res.text);
    return res.json as T;
  }

  /** Same, but returns the raw response (for probes that expect a 400). */
  async raw(operationId: string, args: Record<string, unknown> = {}): Promise<ApiResponse> {
    const spec = OPERATIONS[operationId];
    if (!spec) throw new Error(`${operationId} is not in operations.json`);
    return this.api.call(spec, args, this.credential);
  }

  me() {
    return this.op<{ id: string; name: string; email: string; billing_account_id: string }>('getCurrentUser');
  }

  billingAccount() {
    return this.op<{ id: string; name: string; plan?: { name?: string } }>('getBillingAccount');
  }

  async listFolders(): Promise<{ token: string; name: string; kind: string }[]> {
    const res = await this.op<{ data: { token: string; name: string; kind: string }[] }>('listFolders');
    return res.data;
  }

  createFolder(name: string, kind: 'form' | 'table' = 'form') {
    return this.op<{ token: string; name: string }>('createFolder', { name, kind });
  }

  async listForms(params: {
    q?: string;
    filters?: TaskFilter[];
    sort?: { field: string; order: 'asc' | 'desc' }[];
    limit?: number;
  }): Promise<FormRow[]> {
    const args: Record<string, unknown> = { limit: params.limit ?? 200 };
    if (params.q) args.q = params.q;
    if (params.filters) args.filters = JSON.stringify(params.filters);
    if (params.sort) args.sort = JSON.stringify(params.sort);
    const res = await this.op<{ data: FormRow[] }>('listForms', args);
    return res.data;
  }

  getForm(token: string, include: { theme?: boolean } = {}) {
    return this.op<FormDetail>('getForm', { form_token: token, include_theme: include.theme ?? false });
  }

  createForm(body: Record<string, unknown>) {
    return this.op<FormDetail>('createForm', body);
  }

  updateForm(token: string, body: Record<string, unknown>) {
    return this.op<FormDetail>('updateForm', { form_token: token, ...body });
  }

  /** PATCH /forms/{token}/setting: the operation table does not flatten this body; it all goes under the body key. */
  updateFormSetting(token: string, setting: Record<string, unknown>) {
    return this.op('updateFormSetting', { form_token: token, body: setting });
  }

  updateTheme(token: string, theme: Record<string, unknown>) {
    return this.op('updateFormTheme', { form_token: token, body: theme });
  }

  moveFormToFolder(token: string, folderToken: string | null) {
    return this.op('moveFormToFolder', { form_token: token, folder_token: folderToken });
  }

  /** Exam / evaluation settings: a form of another scene returns 400 → undefined. */
  async sceneSetting(kind: 'exam' | 'evaluation', token: string): Promise<Record<string, unknown> | undefined> {
    const res = await this.raw(kind === 'exam' ? 'getExamSetting' : 'getEvaluationSetting', { form_token: token });
    if (res.status >= 200 && res.status < 300) return (res.json ?? {}) as Record<string, unknown>;
    return undefined;
  }

  async listAllEntries(
    token: string,
    params: { filters?: TaskFilter[]; keyword?: string; fields?: string[] } = {}
  ): Promise<Entry[]> {
    const out: Entry[] = [];
    let next: number | null | undefined;
    for (let page = 0; page < 50; page++) {
      const args: Record<string, unknown> = { form_token: token, limit: 200 };
      if (params.filters) args.filters = JSON.stringify(params.filters);
      if (params.keyword) args.keyword = params.keyword;
      if (params.fields) args.fields = JSON.stringify(params.fields);
      if (next !== undefined && next !== null) args.next = next;
      const res = await this.op<{ data: Entry[]; next: number | null }>('listEntries', args);
      out.push(...res.data);
      if (!res.next || res.data.length === 0) break;
      next = res.next;
    }
    return out;
  }

  async countEntries(token: string, params: { filters?: TaskFilter[]; keyword?: string } = {}): Promise<number> {
    const args: Record<string, unknown> = { form_token: token };
    if (params.filters) args.filters = JSON.stringify(params.filters);
    if (params.keyword) args.keyword = params.keyword;
    const res = await this.op<{ matched_entries: number }>('countEntries', args);
    return res.matched_entries;
  }

  createEntriesBatch(token: string, entries: Record<string, unknown>[]) {
    return this.op<{ created?: unknown[]; errors?: unknown[] }>('createEntriesBatch', { form_token: token, entries });
  }

  /** PATCH /forms/{token}/entries/{serial}: the operation table does not flatten this body; it all goes under the body key. */
  updateEntry(token: string, serial: number, entry: Record<string, unknown>) {
    return this.op('updateEntry', { form_token: token, serial_number: serial, body: entry });
  }

  deleteEntry(token: string, serial: number) {
    return this.op('deleteEntry', { form_token: token, serial_number: serial });
  }
}

/** Flattens get_form's fields (an array of single-key objects) into an ordered list of [api_code, definition]. */
export function flattenFields(form: FormDetail): { api_code: string; def: FieldDef }[] {
  return form.fields.map((item) => {
    const [api_code, def] = Object.entries(item)[0]!;
    return { api_code, def };
  });
}
