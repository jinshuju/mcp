import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, SCHEMAS } from './tools.js';
import { OPERATIONS } from './composites.js';
import { META } from './server.js';

/** The 60 tools documented at open.jinshuju.net/mcp: this server's tool set must match them one to one. */
const BUILTIN = [
  'aggregate_entries',
  'check_field_data',
  'copy_form',
  'count_entries',
  'create_entries',
  'create_entry',
  'create_entry_comment',
  'create_evaluation_form',
  'create_exam_form',
  'create_folder',
  'create_form',
  'create_form_view',
  'create_opensearch_query',
  'create_table',
  'delete_entry',
  'delete_entry_comment',
  'delete_form_view',
  'edit_evaluation_form',
  'edit_exam_form',
  'edit_field_rules',
  'edit_form',
  'edit_form_view',
  'edit_opensearch_query',
  'edit_table',
  'edit_theme',
  'get_current_billing_account',
  'get_current_user',
  'get_entry',
  'get_field_rules',
  'get_form',
  'get_form_data_summary',
  'get_form_view',
  'get_opensearch_field_suggestions',
  'get_opensearch_query',
  'get_table',
  'import_entries_from_file',
  'list_account_users',
  'list_entries',
  'list_entry_comments',
  'list_folders',
  'list_form_cooperators',
  'list_form_entry_stats',
  'list_form_view_entries',
  'list_form_views',
  'list_forms',
  'list_my_submitted_entries',
  'list_my_submitted_forms',
  'list_opensearch_queries',
  'list_tables',
  'move_form',
  'move_table',
  'patch_entries',
  'prepare_entry_attachment_upload',
  'prepare_form_image_upload',
  'prepare_import_file_upload',
  'preview_field_type_change',
  'search_entries_in_forms',
  'search_my_submitted_entries',
  'update_entry',
  'update_entry_comment'
];
/** openapi has no presigned-upload endpoints; these three upload directly instead and are named after the endpoints. */
const RENAMED: Record<string, string> = {
  prepare_entry_attachment_upload: 'upload_entry_attachment',
  prepare_form_image_upload: 'upload_form_image',
  prepare_import_file_upload: 'upload_import_file'
};

test('the tool set matches the 60 documented tools one to one', () => {
  const names = new Set(TOOLS.map((t) => t.name));
  assert.equal(BUILTIN.length, 60);
  const expected = BUILTIN.map((n) => RENAMED[n] ?? n);
  for (const name of expected) assert.ok(names.has(name), `missing ${name}`);
  const extra = [...names].filter((n) => !expected.includes(n));
  assert.deepEqual(extra, [], `unexpected tools: ${extra.join(', ')}`);
  assert.equal(TOOLS.length, META.toolCount);
  for (const name of names) assert.match(name, /^[a-z0-9_]{1,64}$/);
});

test('the operation table covers every openapi operation, including those the composite tools use', () => {
  assert.equal(Object.keys(OPERATIONS).length, META.operationCount);
  for (const id of [
    'createForm',
    'updateForm',
    'updateExamSetting',
    'updateEvaluationSetting',
    'countEntries',
    'countEntriesAcrossForms'
  ]) {
    assert.ok(OPERATIONS[id], id);
  }
  for (const t of TOOLS) assert.ok(OPERATIONS[t.operationId], `${t.name} -> ${t.operationId}`);
});

test('inputSchema has no $ref and no OpenAPI-only keywords', () => {
  const banned = new Set(['$ref', 'discriminator', 'nullable', 'xml', 'example']);
  const walk = (node: unknown, where: string) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      assert.ok(!banned.has(k), `${where}.${k}`);
      walk(v, `${where}.${k}`);
    }
  };
  for (const t of TOOLS) {
    walk(t.inputSchema, t.name);
    if (t.outputSchema) walk(t.outputSchema, `${t.name}.output`);
  }
});

test("a shared parameter's descriptionAppend goes only to the operations that reference it", () => {
  const filtersOf = (name: string) =>
    (TOOLS.find((t) => t.name === name)!.inputSchema.properties as Record<string, { description?: string }>).filters
      ?.description ?? '';
  for (const name of ['list_entries', 'count_entries', 'aggregate_entries', 'get_form_data_summary']) {
    assert.match(filtersOf(name), /exactly the same set of choices/, name);
  }
  for (const name of ['list_forms', 'search_entries_in_forms']) {
    assert.doesNotMatch(
      filtersOf(name),
      /exactly the same set of choices/,
      `${name}'s filters is a different parameter that filters on form properties`
    );
  }
});

/** Query parameters declared with `content: application/json`: the array itself, typed by the content schema, or its JSON text. */
const JSON_TEXT_PARAMS: Record<string, string[]> = {
  list_forms: ['filters', 'sort'],
  list_tables: ['filters', 'sort'],
  check_field_data: ['checks'],
  preview_field_type_change: ['checks'],
  list_entries: ['filters', 'sort'],
  count_entries: ['filters'],
  aggregate_entries: ['metrics', 'dimensions', 'filters'],
  get_form_data_summary: ['filters'],
  search_entries_in_forms: ['filters'],
  list_my_submitted_entries: ['filters']
};

test('a query parameter declared with content: application/json takes the array itself, typed by the content schema, or its JSON text', () => {
  const found: Record<string, string[]> = {};
  for (const t of TOOLS) {
    const properties = t.inputSchema.properties as Record<string, Record<string, unknown>>;
    for (const p of t.params) {
      if (!p.json) continue;
      (found[t.name] ??= []).push(p.name);
      assert.equal(p.array, undefined, `${t.name}.${p.name} is one query value, not name[]=`);
      const schema = properties[p.name];
      assert.deepEqual(schema.type, ['array', 'string'], `${t.name}.${p.name}`);
      const items = schema.items as Record<string, unknown>;
      assert.equal(items.type, 'object', `${t.name}.${p.name}: items are typed`);
      assert.ok(Object.keys(items.properties as object).length > 0, `${t.name}.${p.name}: items have properties`);
      assert.ok(
        Array.isArray((schema.examples as unknown[] | undefined)?.[0]),
        `${t.name}.${p.name}: the example is an array`
      );
      assert.match(
        String(schema.description),
        /an array of (?:\d+ to \d+ |at most \d+ )?[A-Z]\w+ objects/,
        `${t.name}.${p.name}`
      );
    }
    // openapi tells HTTP callers to stringify these themselves; here the runtime does it, so no tool says so
    for (const [name, schema] of Object.entries(properties)) {
      assert.doesNotMatch(
        String(schema.description ?? ''),
        /JSON string|JSON\.stringify|do not pass the array/,
        `${t.name}.${name}`
      );
    }
  }
  assert.deepEqual(found, JSON_TEXT_PARAMS);
  // ScopeCondition is inlined: filters names its keys and operators without a get_schema call
  const filters = (
    TOOLS.find((t) => t.name === 'list_entries')!.inputSchema.properties as Record<string, Record<string, unknown>>
  ).filters;
  const condition = filters.items as { required: string[]; properties: Record<string, { enum?: string[] }> };
  assert.deepEqual(condition.required, ['field', 'operator']);
  assert.ok(condition.properties.operator.enum?.includes('any_in'));
  // count_entries across several forms goes through its own operation, whose filters is JSON text too
  assert.equal(OPERATIONS.countEntriesAcrossForms.params.find((p) => p.name === 'filters')?.json, true);
});

/** Query arrays declared with `explode: false`: the array itself or its comma-separated text, sent as one `name=a,b`. */
const COMMA_LIST_PARAMS: Record<string, string[]> = {
  list_entries: ['fields'],
  get_entry: ['fields'],
  get_form_data_summary: ['fields'],
  search_entries_in_forms: ['form_tokens'],
  list_my_submitted_entries: ['fields'],
  search_my_submitted_entries: ['form_tokens']
};

test('a query array declared with explode: false takes the array of strings or its comma-separated text', () => {
  const found: Record<string, string[]> = {};
  for (const t of TOOLS) {
    const properties = t.inputSchema.properties as Record<string, Record<string, unknown>>;
    for (const p of t.params) {
      if (!p.comma) continue;
      (found[t.name] ??= []).push(p.name);
      assert.equal(p.array, undefined, `${t.name}.${p.name} is one query value, not name[]=`);
      assert.equal(p.json, undefined, `${t.name}.${p.name}`);
      assert.deepEqual(properties[p.name].type, ['array', 'string'], `${t.name}.${p.name}`);
      assert.deepEqual(properties[p.name].items, { type: 'string' }, `${t.name}.${p.name}`);
    }
  }
  assert.deepEqual(found, COMMA_LIST_PARAMS);
  // count_entries across several forms sends its form_tokens the same way
  assert.equal(OPERATIONS.countEntriesAcrossForms.params.find((p) => p.name === 'form_tokens')?.comma, true);
});

test('path parameters are in inputSchema.required, and flattened body properties are at the top level', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  for (const t of TOOLS) {
    const required = (t.inputSchema.required as string[] | undefined) ?? [];
    for (const p of t.params) if (p.in === 'path') assert.ok(required.includes(p.name), `${t.name}.${p.name}`);
    for (const match of t.path.matchAll(/\{(\w+)\}/g))
      assert.ok(
        t.params.some((p) => p.name === match[1]),
        t.name
      );
  }
  const createForm = byName.create_form.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.ok(
    createForm.name && createForm.fields && createForm.scene,
    "create_form's body properties are lifted to the top level"
  );
  assert.equal(byName.create_form.body?.flatten, true);
  assert.match(String((createForm.fields.items as Record<string, unknown>).description), /FieldInput/);
  const createEntry = byName.create_entry.inputSchema.properties as Record<string, unknown>;
  assert.ok(createEntry.entry, "create_entry's data is nested under entry");
  assert.equal(byName.create_entry.body?.param, 'entry');
  const upload = byName.upload_form_image.inputSchema.properties as Record<string, unknown>;
  assert.ok(upload.file_base64 && upload.file_name && upload.content_type && !('file' in upload));
  assert.equal(byName.upload_form_image.body?.contentType, 'multipart/form-data');
});

test('input shapes of the projection and composite tools', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  const rules = byName.edit_field_rules;
  assert.equal(rules.operationId, 'updateForm');
  assert.equal(rules.body?.wrap, 'field_rules');
  assert.deepEqual(Object.keys(rules.inputSchema.properties as object).sort(), [
    'add',
    'form_token',
    'remove',
    'update'
  ]);
  const exam = byName.create_exam_form;
  assert.equal(exam.composite?.kind, 'scene_form_create');
  const examProps = exam.inputSchema.properties as Record<string, unknown>;
  assert.ok(examProps.name && examProps.fields && examProps.exam_setting);
  assert.deepEqual(exam.inputSchema.required, ['name', 'fields']);
  // Models pass scene anyway: the create tools accept it, pinned to their own scene, and do not require it
  assert.equal((examProps.scene as { const?: string }).const, 'exam');
  const evaluationProps = byName.create_evaluation_form.inputSchema.properties as Record<string, { const?: string }>;
  assert.equal(evaluationProps.scene.const, 'evaluation');
  const edit = byName.edit_evaluation_form;
  assert.equal(edit.composite?.settingOperation, 'updateEvaluationSetting');
  assert.ok((edit.inputSchema.properties as Record<string, unknown>).evaluation_setting);
  const count = byName.count_entries.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(count.form_token.type, ['string', 'array']);
});

test('large schemas become pointers and are found in the get_schema catalog', () => {
  assert.ok(SCHEMAS.FieldInput && SCHEMAS.TextFieldInput);
  const variants = SCHEMAS.FieldInput['x-variants'] as Record<string, string>;
  assert.equal(variants.TextField, 'TextFieldInput');
  for (const name of META.pointerSchemas) assert.ok(SCHEMAS[name], name);
});

test('annotations are inferred from the HTTP method and the overlay can override them; the scope line goes into scopes', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  assert.equal(byName.list_forms.annotations.readOnlyHint, true);
  assert.equal(byName.delete_entry.annotations.destructiveHint, true);
  assert.equal(byName.create_entry.annotations.readOnlyHint, false);
  assert.ok(byName.create_form.description.includes('get_schema'));
  assert.deepEqual(byName.list_entries.scopes, ['read_entries']);
  assert.ok(!byName.list_entries.description.includes('OAuth scope'));
  // In a one-line description the scope follows the last sentence; from the line that depends on image_type only the scope names are taken
  assert.deepEqual(byName.list_form_views.scopes, ['forms']);
  assert.ok(!byName.list_form_views.description.includes('OAuth scope'));
  assert.deepEqual(byName.upload_form_image.scopes, ['forms', 'form_setting']);
  assert.ok(!byName.upload_form_image.description.includes('OAuth scope'));
});

test('the import tools steer data pasted into the conversation to create_entries; upload_import_file says nothing about HTTP auth or multipart', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  for (const name of ['upload_import_file', 'import_entries_from_file']) {
    assert.match(byName[name].description, /create_entries/, name);
  }
  const upload = byName.upload_import_file.description;
  assert.ok(upload.startsWith('Upload an import file\n'), 'the summary stays on the first line');
  assert.doesNotMatch(upload, /multipart|credential|401/);
  assert.match(upload, /xls \/ xlsx \/ csv/);
});
