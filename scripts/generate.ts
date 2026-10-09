/**
 * openapi.yaml + mcp.overlay.yaml -> src/generated/{operations,tools,schemas,meta}.json
 *
 * 这是整个项目唯一「知道 OpenAPI」的地方。运行时只读产物，不解析 YAML。
 * 产物提交进仓库：reviewer 能在 PR 里看到 openapi.yaml 的改动如何影响工具，
 * CI 里 `npm run generate && git diff --exit-code src/generated` 保证不漂移。
 *
 * 用法：npm run generate
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

type Json = Record<string, unknown>;
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const METHODS: Method[] = ['get', 'post', 'put', 'patch', 'delete'];

const root = new URL('..', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

interface ToolOverride {
  descriptionAppend?: string;
  annotations?: Json;
  outputSchema?: boolean;
  title?: string;
}
interface Overlay {
  include: Record<string, string>;
  projections?: Record<string, { operationId: string; bodyKey: string; title?: string; description?: string }>;
  composites?: Record<
    string,
    {
      kind: 'scene_form_create' | 'scene_form_update' | 'count_entries';
      scene?: string;
      settingOperation?: string;
      settingKey?: string;
      title?: string;
      description?: string;
    }
  >;
  pointerSchemas?: string[];
  omitSchemas?: string[];
  collapseVariantsMinBranches?: number;
  outputSchemaMaxChars?: number;
  bodyParam?: Record<string, string>;
  tools?: Record<string, ToolOverride>;
}

const spec = parse(read('spec/openapi.yaml')) as Json;
const overlay = parse(read('mcp.overlay.yaml')) as Overlay;

const components = (spec.components ?? {}) as { schemas?: Record<string, Json> };
const schemas = components.schemas ?? {};
const pointer = new Set(overlay.pointerSchemas ?? []);
const omit = new Set(overlay.omitSchemas ?? []);
let collapseMin = overlay.collapseVariantsMinBranches ?? 3;
const bodyParam = overlay.bodyParam ?? {};
const toolOverrides = overlay.tools ?? {};
const outputSchemaMaxChars = overlay.outputSchemaMaxChars ?? 700;

// ---------- $ref 解析 ----------

function lookup(ref: string): Json {
  if (!ref.startsWith('#/')) throw new Error(`external $ref not supported: ${ref}`);
  let node: unknown = spec;
  for (const part of ref.slice(2).split('/')) {
    node = (node as Json)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error(`unresolved $ref: ${ref}`);
  }
  return structuredClone(node as Json);
}

function refName(ref: string): string {
  return ref.split('/').pop() ?? ref;
}

function pointerStub(name: string): Json {
  return {
    type: 'object',
    description: `结构见 schema「${name}」：调用 get_schema 工具（name="${name}"）或读取资源 jinshuju://schemas/${name}。`
  };
}

function isPointerStub(schema: unknown): boolean {
  return (
    !!schema &&
    typeof schema === 'object' &&
    typeof (schema as Json).description === 'string' &&
    ((schema as Json).description as string).startsWith('结构见 schema「')
  );
}

/**
 * 内联所有 $ref（指针 schema 除外），并把 OpenAPI 专有关键字清理成纯 JSON Schema 2020-12。
 * `seen` 防环：递归引用退化成 {type: object}。
 */
function inline(node: unknown, seen: readonly string[] = []): unknown {
  if (Array.isArray(node)) return node.map((item) => inline(item, seen));
  if (node === null || typeof node !== 'object') return node;
  const obj = node as Json;
  if (typeof obj.$ref === 'string') {
    const ref = obj.$ref;
    const name = refName(ref);
    if (pointer.has(name)) return pointerStub(name);
    if (omit.has(name)) return {};
    if (seen.includes(ref)) return { type: 'object', description: `递归结构（${name}）` };
    const target = inline(lookup(ref), [...seen, ref]) as Json;
    const siblings = { ...obj };
    delete siblings.$ref;
    return Object.keys(siblings).length ? { ...target, ...(inline(siblings, seen) as Json) } : target;
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'discriminator' || key === 'xml' || key === 'externalDocs' || key === 'nullable') continue;
    if (key === 'example') {
      // OpenAPI 3.0 写法 -> JSON Schema 2020-12 的 examples
      if (!('examples' in obj)) out.examples = [value];
      continue;
    }
    out[key] = inline(value, seen);
  }
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    // omitSchemas 留下的空壳不占位
    const kept = list.filter((item) => !(item && typeof item === 'object' && Object.keys(item as Json).length === 0));
    if (!kept.length) {
      delete out[key];
      continue;
    }
    out[key] = kept;
  }
  return collapseVariants(out);
}

/**
 * 内联在工具入参里的「按 type 分支」联合（oneOf / anyOf 的每个分支都有 title，且分支够多）：
 * 分支全文动辄上万字符，而每个分支都是 components.schemas 里的具名 schema，get_schema 能查。
 * 这里只保留公共属性（type 枚举、label 等），把分支名写进描述，形状校验交给服务端。
 */
function collapseVariants(schema: Json): Json {
  for (const key of ['oneOf', 'anyOf'] as const) {
    const list = schema[key];
    if (!Array.isArray(list) || list.length < collapseMin) continue;
    const titles = list.map((item) => (item as Json)?.title).filter((t): t is string => typeof t === 'string');
    if (titles.length !== list.length) continue;
    const { [key]: _dropped, ...rest } = schema;
    const hint = `按 type 分支，每个分支的专属属性用 get_schema 查看：${titles.slice(0, 8).join('、')}${
      titles.length > 8 ? ` 等 ${titles.length} 种` : ''
    }。`;
    rest.description = rest.description ? `${rest.description}\n${hint}` : hint;
    if (rest.type === undefined) rest.type = 'object';
    return rest;
  }
  return schema;
}

// ---------- 描述 / 注解 ----------

const SCOPE_LINE = /^\s*OAuth 令牌需要 scope[:：]\s*(.+?)\s*$/m;

function splitScopes(description: string): { text: string; scopes: string[] } {
  const match = SCOPE_LINE.exec(description);
  const scopes = match ? match[1].split(/[\s/、,]+/).filter(Boolean) : [];
  const text = description
    .replace(SCOPE_LINE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, scopes };
}

function inferAnnotations(method: Method): Json {
  switch (method) {
    case 'get':
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    case 'delete':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
    case 'put':
    case 'patch':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    default:
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  }
}

// ---------- 操作表：openapi 的每个操作一条，运行时发请求用 ----------

interface ParamSpec {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  /** query 数组序列化成 name[]=a&name[]=b（服务端按数组读取） */
  array?: boolean;
}
interface BodySpec {
  contentType: 'application/json' | 'multipart/form-data';
  required: boolean;
  /** 请求体属性在入参顶层（去掉 path / query 参数后的其余键就是请求体） */
  flatten: boolean;
  /** 不 flatten 时，请求体在入参里的键名 */
  param?: string;
  /** 发出前再包一层：{ [wrap]: payload }（投影工具用） */
  wrap?: string;
}
interface OperationSpec {
  operationId: string;
  summary: string;
  description: string;
  tag: string;
  method: Method;
  path: string;
  params: ParamSpec[];
  /** 入参里的属性（flatten 时含请求体属性）；运行时据此区分参数与请求体 */
  paramNames: string[];
  body?: BodySpec;
  successStatus: number;
  scopes: string[];
  responseSchema?: string;
}
interface ToolSpec extends OperationSpec {
  name: string;
  title: string;
  inputSchema: Json;
  outputSchema?: Json;
  annotations: Json;
  composite?: { kind: string; scene?: string; settingOperation?: string; settingKey?: string };
}

const paths = spec.paths as Record<string, Json>;
const rawOps = new Map<string, { op: Json; method: Method; path: string; shared: Json[] }>();
for (const [path, item] of Object.entries(paths)) {
  const shared = (item.parameters ?? []) as Json[];
  for (const method of METHODS) {
    const op = item[method] as Json | undefined;
    if (!op) continue;
    const operationId = op.operationId as string;
    if (!operationId) throw new Error(`${method.toUpperCase()} ${path} has no operationId`);
    if (rawOps.has(operationId)) throw new Error(`duplicate operationId ${operationId}`);
    rawOps.set(operationId, { op, method, path, shared });
  }
}

interface Built {
  operation: OperationSpec;
  inputSchema: Json;
  outputSchema?: Json;
  summary: string;
}

/** 把一个操作变成 {操作表项, inputSchema, outputSchema}。bodyMode：flatten / 嵌套键名。 */
function buildOperation(operationId: string, bodyMode: 'flatten' | string): Built {
  const raw = rawOps.get(operationId);
  if (!raw) throw new Error(`unknown operationId ${operationId}`);
  const { op, method, path, shared } = raw;

  const properties: Json = {};
  const required: string[] = [];
  const params: ParamSpec[] = [];
  for (const rawParam of [...shared, ...((op.parameters ?? []) as Json[])]) {
    const p = inline(rawParam) as Json;
    const where = p.in as string;
    if (where !== 'path' && where !== 'query') continue; // header / cookie 参数不暴露
    const name = p.name as string;
    const schema = { ...((p.schema as Json) ?? { type: 'string' }) };
    if (p.description) schema.description = p.description;
    if (p.example !== undefined && !('examples' in schema)) schema.examples = [p.example];
    properties[name] = schema;
    const isRequired = where === 'path' || p.required === true;
    if (isRequired) required.push(name);
    params.push({ name, in: where, required: isRequired, array: schema.type === 'array' || undefined });
  }

  let body: BodySpec | undefined;
  const requestBody = op.requestBody as Json | undefined;
  if (requestBody) {
    const rb = inline(requestBody) as Json;
    const content = (rb.content ?? {}) as Record<string, Json>;
    let schema: Json | undefined;
    let contentType: BodySpec['contentType'] | undefined;
    if (content['application/json']) {
      contentType = 'application/json';
      schema = (content['application/json'].schema as Json) ?? { type: 'object' };
    } else if (content['multipart/form-data']) {
      contentType = 'multipart/form-data';
      schema = multipartSchema(content['multipart/form-data'].schema as Json);
    }
    if (schema && contentType) {
      schema = mergeAllOf(schema);
      const flattenable =
        bodyMode === 'flatten' &&
        schema.type === 'object' &&
        !!schema.properties &&
        schema.additionalProperties !== true &&
        !isPointerStub(schema);
      if (flattenable) {
        for (const [key, value] of Object.entries(schema.properties as Json)) {
          if (key in properties) throw new Error(`${operationId}: body property ${key} clashes with a parameter`);
          properties[key] = value;
        }
        for (const key of (schema.required as string[]) ?? []) required.push(key);
        body = { contentType, required: rb.required === true, flatten: true };
      } else {
        const param = bodyMode === 'flatten' ? 'body' : bodyMode;
        properties[param] = schema;
        if (rb.required) required.push(param);
        body = { contentType, required: rb.required === true, flatten: false, param };
      }
    }
  }

  const inputSchema: Json = { type: 'object', properties, additionalProperties: false };
  if (required.length) inputSchema.required = [...new Set(required)];

  // 成功响应 -> outputSchema
  const responses = (op.responses ?? {}) as Record<string, Json>;
  const okStatus = Object.keys(responses).find((s) => s.startsWith('2')) ?? '200';
  const okContent = ((responses[okStatus]?.content ?? {}) as Record<string, Json>)['application/json'];
  let outputSchema: Json | undefined;
  let responseSchema: string | undefined;
  if (okContent?.schema) {
    const rawSchema = okContent.schema as Json;
    responseSchema = typeof rawSchema.$ref === 'string' ? refName(rawSchema.$ref) : undefined;
    const resolved = inline(rawSchema) as Json;
    const isObject = resolved.type === 'object' || 'properties' in resolved;
    if (isObject && JSON.stringify(resolved).length <= outputSchemaMaxChars) outputSchema = resolved;
  }

  const { text, scopes } = splitScopes((op.description as string) ?? '');
  const summary = ((op.summary as string) ?? '').trim();
  const operation: OperationSpec = {
    operationId,
    summary,
    description: text,
    tag: ((op.tags as string[]) ?? ['Other'])[0],
    method,
    path,
    params,
    paramNames: params.map((p) => p.name),
    body,
    successStatus: Number(okStatus),
    scopes,
    responseSchema
  };
  return { operation, inputSchema, outputSchema, summary };
}

/** `allOf` 里全是带 properties 的对象（且没有指针 stub）时合并成一个对象，便于 flatten。 */
function mergeAllOf(schema: Json): Json {
  const list = schema.allOf;
  if (!Array.isArray(list)) return schema;
  const parts = list as Json[];
  if (!parts.every((p) => p && typeof p === 'object' && !isPointerStub(p) && (p.properties || p.required)))
    return schema;
  const { allOf: _dropped, ...rest } = schema;
  const merged: Json = { type: 'object', ...rest, properties: { ...(rest.properties as Json | undefined) } };
  const required = new Set<string>((rest.required as string[]) ?? []);
  for (const part of parts) {
    Object.assign(merged.properties as Json, (part.properties as Json) ?? {});
    for (const key of (part.required as string[]) ?? []) required.add(key);
    if (part.description && !merged.description) merged.description = part.description;
    if (part.additionalProperties !== undefined) merged.additionalProperties = part.additionalProperties;
  }
  if (required.size) merged.required = [...required];
  return merged;
}

/** 文件上传：multipart 里的二进制字段改成 base64 三元组，运行时再拼 FormData。 */
function multipartSchema(raw: Json): Json {
  const schema = structuredClone(raw ?? {});
  const props = (schema.properties ?? {}) as Json;
  const req = new Set((schema.required as string[]) ?? []);
  if ('file' in props) {
    const fileDesc = ((props.file as Json).description as string) ?? '要上传的文件';
    delete props.file;
    req.delete('file');
    props.file_base64 = { type: 'string', description: `${fileDesc}。文件内容的 Base64（可带 data URI 前缀）。` };
    props.file_name = { type: 'string', description: '文件名（含扩展名）' };
    props.content_type = { type: 'string', description: '文件的 MIME 类型，如 image/png、text/csv' };
    req.add('file_base64');
    req.add('file_name');
    req.add('content_type');
  }
  schema.properties = props;
  schema.required = [...req];
  return schema;
}

function describe(built: Built, extra: string[] = [], outputSchema = built.outputSchema): string {
  const parts = [built.summary, built.operation.description];
  if (!outputSchema && built.operation.responseSchema) {
    parts.push(`返回结构见 schema「${built.operation.responseSchema}」（get_schema 可查看）。`);
  }
  return [...parts, ...extra].filter(Boolean).join('\n');
}

// 运行时操作表：全部操作，一律 flatten（组合工具在代码里直接按请求体键传参）
const operations: Record<string, OperationSpec> = {};
for (const operationId of rawOps.keys()) operations[operationId] = buildOperation(operationId, 'flatten').operation;

// ---------- 工具 ----------

const tools: ToolSpec[] = [];

for (const [operationId, name] of Object.entries(overlay.include)) {
  const override = toolOverrides[operationId] ?? {};
  const built = buildOperation(operationId, bodyParam[operationId] ?? 'flatten');
  const outputSchema = override.outputSchema === false ? undefined : (built.outputSchema ?? undefined);
  tools.push({
    ...built.operation,
    name,
    title: override.title ?? (built.summary || operationId),
    description: describe(built, override.descriptionAppend ? [override.descriptionAppend.trim()] : [], outputSchema),
    inputSchema: built.inputSchema,
    outputSchema,
    annotations: { ...inferAnnotations(built.operation.method), ...override.annotations }
  });
}

for (const [name, projection] of Object.entries(overlay.projections ?? {})) {
  const built = buildOperation(projection.operationId, 'flatten');
  const sub = (built.inputSchema.properties as Json)[projection.bodyKey] as Json | undefined;
  if (!sub || sub.type !== 'object' || !sub.properties) {
    throw new Error(`projection ${name}: ${projection.operationId}.${projection.bodyKey} is not an object schema`);
  }
  const properties: Json = {};
  const required: string[] = [];
  for (const p of built.operation.params) {
    properties[p.name] = (built.inputSchema.properties as Json)[p.name];
    if (p.required) required.push(p.name);
  }
  for (const [key, value] of Object.entries(sub.properties as Json)) {
    if (key in properties) throw new Error(`projection ${name}: ${key} clashes with a parameter`);
    properties[key] = value;
  }
  for (const key of (sub.required as string[]) ?? []) required.push(key);
  const inputSchema: Json = { type: 'object', properties, additionalProperties: false };
  if (required.length) inputSchema.required = required;
  tools.push({
    ...built.operation,
    body: { ...built.operation.body!, flatten: true, param: undefined, wrap: projection.bodyKey },
    name,
    title: projection.title ?? name,
    description: [projection.description?.trim(), (sub.description as string) ?? ''].filter(Boolean).join('\n'),
    inputSchema,
    annotations: inferAnnotations(built.operation.method)
  });
}

for (const [name, composite] of Object.entries(overlay.composites ?? {})) {
  const primaryId =
    composite.kind === 'scene_form_create'
      ? 'createForm'
      : composite.kind === 'scene_form_update'
        ? 'updateForm'
        : 'countEntries';
  const built = buildOperation(primaryId, 'flatten');
  const inputSchema = structuredClone(built.inputSchema);
  const properties = inputSchema.properties as Json;
  const extra: string[] = [];
  if (composite.kind === 'count_entries') {
    const across = buildOperation('countEntriesAcrossForms', 'flatten');
    properties.form_token = {
      type: ['string', 'array'],
      items: { type: 'string' },
      maxItems: 10,
      description: '表单 token；或最多 10 个 token 的数组，一次统计多个表单'
    };
    extra.push(`多表单统计（form_token 为数组时）：${across.operation.description}`);
  } else {
    if (!composite.settingOperation || !composite.settingKey || !composite.scene) {
      throw new Error(`composite ${name}: scene / settingOperation / settingKey are required`);
    }
    const setting = buildOperation(composite.settingOperation, 'flatten');
    delete properties.scene;
    properties[composite.settingKey] = {
      ...((setting.inputSchema.properties as Json).body
        ? ((setting.inputSchema.properties as Json).body as Json)
        : {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(setting.inputSchema.properties as Json).filter(
                ([k]) => !setting.operation.paramNames.includes(k)
              )
            )
          }),
      description: `${composite.scene === 'exam' ? '考试' : '测评'}设置（${composite.settingOperation}）：${setting.operation.description}`
    };
    extra.push(built.operation.description);
  }
  tools.push({
    ...built.operation,
    name,
    title: composite.title ?? name,
    description: [composite.description?.trim(), ...extra].filter(Boolean).join('\n'),
    inputSchema,
    // 多表单计数的响应很小，随 tools/list 下发；考试 / 测评表单的响应是整个 Form，太大。
    outputSchema: composite.kind === 'count_entries' ? built.outputSchema : undefined,
    annotations: inferAnnotations(built.operation.method),
    composite: {
      kind: composite.kind,
      scene: composite.scene,
      settingOperation: composite.settingOperation,
      settingKey: composite.settingKey
    }
  });
}

// 名字唯一且合法（MCP 建议 ^[a-zA-Z0-9_-]{1,128}$）
const names = new Set<string>();
for (const tool of tools) {
  if (!/^[a-z0-9_]{1,64}$/.test(tool.name)) throw new Error(`bad tool name: ${tool.name}`);
  if (names.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
  names.add(tool.name);
}

// ---------- schema 目录（get_schema / resources 用） ----------

/** 组件 schema：内联到「其它指针 schema」为止，自身不做指针替换、不折叠。 */
function componentSchema(name: string): Json {
  const raw = schemas[name];
  if (!raw) throw new Error(`unknown schema ${name}`);
  const wasPointer = pointer.has(name);
  if (wasPointer) pointer.delete(name);
  const savedCollapse = collapseMin;
  collapseMin = Number.POSITIVE_INFINITY;
  try {
    const resolved = inline(structuredClone(raw), [`#/components/schemas/${name}`]) as Json;
    const disc = (raw as Json).discriminator as Json | undefined;
    if (disc?.mapping) {
      const mapping = Object.fromEntries(
        Object.entries(disc.mapping as Record<string, string>).map(([k, v]) => [k, refName(v)])
      );
      resolved['x-variants'] = mapping;
      resolved.description =
        `${(resolved.description as string) ?? ''}\n按 type 分支：x-variants 列出了 type -> 分支 schema 名，用 get_schema 查看具体分支（如 "TextFieldInput"）。`.trim();
    }
    return resolved;
  } finally {
    collapseMin = savedCollapse;
    if (wasPointer) pointer.add(name);
  }
}

const schemaCatalog: Record<string, Json> = {};
for (const name of Object.keys(schemas).sort()) schemaCatalog[name] = componentSchema(name);

// ---------- 写出 ----------

const info = spec.info as Json;
const specHash = createHash('sha256').update(read('spec/openapi.yaml')).digest('hex').slice(0, 16);
const meta = {
  generatedFrom: { title: info.title, version: info.version, sha256: specHash },
  baseUrl: ((spec.servers as Json[])?.[0]?.url as string) ?? 'https://jinshuju.net/api/v1',
  toolCount: tools.length,
  operationCount: Object.keys(operations).length,
  tools: Object.fromEntries(
    tools.map((t) => [
      t.name,
      t.composite ? `${t.operationId}+${t.composite.settingOperation ?? 'countEntriesAcrossForms'}` : t.operationId
    ])
  ),
  pointerSchemas: [...pointer].sort(),
  omitSchemas: [...omit].sort(),
  tags: Object.fromEntries(
    ((spec.tags as Json[]) ?? []).map((t) => [t.name as string, (t.description as string) ?? ''])
  )
};

mkdirSync(new URL('src/generated/', root), { recursive: true });
writeFileSync(new URL('src/generated/operations.json', root), `${JSON.stringify(operations, null, 1)}\n`);
writeFileSync(new URL('src/generated/tools.json', root), `${JSON.stringify(tools, null, 1)}\n`);
writeFileSync(new URL('src/generated/schemas.json', root), `${JSON.stringify(schemaCatalog, null, 1)}\n`);
writeFileSync(new URL('src/generated/meta.json', root), `${JSON.stringify(meta, null, 2)}\n`);

const byTag: Record<string, number> = {};
for (const t of tools) byTag[t.tag] = (byTag[t.tag] ?? 0) + 1;
console.log(`generated ${tools.length} tools over ${Object.keys(operations).length} operations (spec ${specHash})`);
console.log(
  Object.entries(byTag)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')
);
console.log(
  `outputSchema inlined for ${tools.filter((t) => t.outputSchema).length} tools; schemas catalogued: ${Object.keys(schemaCatalog).length}`
);
