import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, SCHEMAS } from './tools.js';
import { OPERATIONS } from './composites.js';
import { META } from './server.js';

/** builtin MCP（goldendata gem）的 60 个工具：本服务的工具集必须与之一一对齐。 */
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
/** openapi 没有「预签名上传」接口，这三个改为直接上传，名字随接口。 */
const RENAMED: Record<string, string> = {
  prepare_entry_attachment_upload: 'upload_entry_attachment',
  prepare_form_image_upload: 'upload_form_image',
  prepare_import_file_upload: 'upload_import_file'
};

test('工具集与 builtin MCP 的 60 个工具一一对齐', () => {
  const names = new Set(TOOLS.map((t) => t.name));
  assert.equal(BUILTIN.length, 60);
  const expected = BUILTIN.map((n) => RENAMED[n] ?? n);
  for (const name of expected) assert.ok(names.has(name), `缺少 ${name}`);
  const extra = [...names].filter((n) => !expected.includes(n));
  assert.deepEqual(extra, [], `多出的工具：${extra.join(', ')}`);
  assert.equal(TOOLS.length, META.toolCount);
  for (const name of names) assert.match(name, /^[a-z0-9_]{1,64}$/);
});

test('操作表覆盖 openapi 全部操作，组合工具用到的操作都在', () => {
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

test('inputSchema 里没有 $ref，也没有 OpenAPI 专有关键字', () => {
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

test('路径参数都在 inputSchema.required 里，flatten 的请求体属性在顶层', () => {
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
  assert.ok(createForm.name && createForm.fields && createForm.scene, 'create_form 的请求体属性提升到顶层');
  assert.equal(byName.create_form.body?.flatten, true);
  assert.match(String((createForm.fields.items as Record<string, unknown>).description), /FieldInput/);
  const createEntry = byName.create_entry.inputSchema.properties as Record<string, unknown>;
  assert.ok(createEntry.entry, 'create_entry 的数据嵌在 entry 下');
  assert.equal(byName.create_entry.body?.param, 'entry');
  const upload = byName.upload_form_image.inputSchema.properties as Record<string, unknown>;
  assert.ok(upload.file_base64 && upload.file_name && upload.content_type && !('file' in upload));
  assert.equal(byName.upload_form_image.body?.contentType, 'multipart/form-data');
});

test('投影与组合工具的入参形状', () => {
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
  assert.ok(examProps.name && examProps.fields && examProps.exam_setting && !('scene' in examProps));
  assert.deepEqual(exam.inputSchema.required, ['name', 'fields']);
  const edit = byName.edit_evaluation_form;
  assert.equal(edit.composite?.settingOperation, 'updateEvaluationSetting');
  assert.ok((edit.inputSchema.properties as Record<string, unknown>).evaluation_setting);
  const count = byName.count_entries.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(count.form_token.type, ['string', 'array']);
});

test('大 schema 被指针化，并能用 get_schema 的目录查到', () => {
  assert.ok(SCHEMAS.FieldInput && SCHEMAS.TextFieldInput);
  const variants = SCHEMAS.FieldInput['x-variants'] as Record<string, string>;
  assert.equal(variants.TextField, 'TextFieldInput');
  for (const name of META.pointerSchemas) assert.ok(SCHEMAS[name], name);
});

test('注解按 HTTP 方法推断，overlay 可覆盖；scope 行抽到 scopes', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  assert.equal(byName.list_forms.annotations.readOnlyHint, true);
  assert.equal(byName.delete_entry.annotations.destructiveHint, true);
  assert.equal(byName.create_entry.annotations.readOnlyHint, false);
  assert.ok(byName.create_form.description.includes('get_schema'));
  assert.deepEqual(byName.list_entries.scopes, ['read_entries']);
  assert.ok(!byName.list_entries.description.includes('OAuth 令牌需要 scope'));
});
