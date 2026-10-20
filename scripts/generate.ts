/**
 * openapi.yaml + mcp.overlay.yaml -> src/generated/{operations,tools,schemas,meta}.json
 *
 * This is the only place in the project that knows OpenAPI. The runtime only reads the output and never parses YAML.
 * The output is committed: reviewers see in the PR how an openapi.yaml change affects the tools, and
 * `npm run generate && git diff --exit-code src/generated` in CI keeps it from drifting.
 *
 * Usage: npm run generate
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
  /** Replaces the openapi operation description entirely (summary kept); only when the original is noise to the model */
  description?: string;
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
  parameters?: Record<string, { descriptionAppend?: string }>;
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
const parameterOverrides = overlay.parameters ?? {};
const outputSchemaMaxChars = overlay.outputSchemaMaxChars ?? 700;

// ---------- $ref resolution ----------

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

const POINTER_PREFIX = 'Shape: schema ';

function pointerStub(name: string): Json {
  return {
    type: 'object',
    description: `${POINTER_PREFIX}"${name}"; call get_schema (name="${name}") or read the resource jinshuju://schemas/${name}.`
  };
}

function isPointerStub(schema: unknown): boolean {
  return (
    !!schema &&
    typeof schema === 'object' &&
    typeof (schema as Json).description === 'string' &&
    ((schema as Json).description as string).startsWith(POINTER_PREFIX)
  );
}

/**
 * Inlines every $ref (except pointer schemas) and cleans OpenAPI-only keywords into plain JSON Schema 2020-12.
 * `seen` guards against cycles: a recursive reference degrades to {type: object}.
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
    if (seen.includes(ref)) return { type: 'object', description: `Recursive structure (${name})` };
    const target = inline(lookup(ref), [...seen, ref]) as Json;
    const siblings = { ...obj };
    delete siblings.$ref;
    return Object.keys(siblings).length ? { ...target, ...(inline(siblings, seen) as Json) } : target;
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'discriminator' || key === 'xml' || key === 'externalDocs' || key === 'nullable') continue;
    if (key === 'example') {
      // OpenAPI 3.0 style -> JSON Schema 2020-12 examples
      if (!('examples' in obj)) out.examples = [value];
      continue;
    }
    out[key] = inline(value, seen);
  }
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    // empty shells left by omitSchemas take no slot
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
 * A union that branches on type, inlined in a tool's input (every oneOf / anyOf branch has a title, and there are enough
 * branches): the full branches easily run past ten thousand characters, while each branch is a named schema in
 * components.schemas that get_schema can look up. Only the common properties stay (the type enum, label, etc.), the
 * branch names go into the description, and shape validation is left to the server.
 */
function collapseVariants(schema: Json): Json {
  for (const key of ['oneOf', 'anyOf'] as const) {
    const list = schema[key];
    if (!Array.isArray(list) || list.length < collapseMin) continue;
    const titles = list.map((item) => (item as Json)?.title).filter((t): t is string => typeof t === 'string');
    if (titles.length !== list.length) continue;
    const { [key]: _dropped, ...rest } = schema;
    const hint = `Branches on type; get_schema shows each branch's own properties: ${titles.slice(0, 8).join(', ')}${
      titles.length > 8 ? `, ${titles.length} in all` : ''
    }.`;
    rest.description = rest.description ? `${rest.description}\n${hint}` : hint;
    if (rest.type === undefined) rest.type = 'object';
    return rest;
  }
  return schema;
}

// ---------- descriptions / annotations ----------

/**
 * `OAuth scope: forms` in an operation description: on a line of its own in a multi-line description, at the end of the
 * sentence in a one-line one. It goes into scopes and stays out of the tool description. A few are conditional
 * (`forms when image_type … ; form_setting otherwise`); from those, only scope names that appear on their own elsewhere
 * in the spec are taken.
 */
const SCOPE_LINE = /(?:^|[ \t]+)OAuth scope:[ \t]*(.+?)[ \t]*(?:\n|$)/m;
const SCOPE_LIST = /^[a-z_]+(?:\s*[/,]\s*[a-z_]+)*$/;

let scopeNames: Set<string> | undefined;
function knownScopes(): Set<string> {
  scopeNames ??= new Set(
    [...rawOps.values()].flatMap(({ op }) => {
      const value = SCOPE_LINE.exec((op.description as string) ?? '')?.[1] ?? '';
      return SCOPE_LIST.test(value) ? value.split(/[\s/,]+/) : [];
    })
  );
  return scopeNames;
}

function splitScopes(description: string): { text: string; scopes: string[] } {
  const value = SCOPE_LINE.exec(description)?.[1];
  const scopes = !value
    ? []
    : SCOPE_LIST.test(value)
      ? value.split(/[\s/,]+/)
      : [...new Set(value.match(/[a-z_]+/g))].filter((word) => knownScopes().has(word));
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

// ---------- operation table: one entry per openapi operation, used to send requests at runtime ----------

interface ParamSpec {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  /** A query array is serialized as name[]=a&name[]=b (the server reads it as an array) */
  array?: boolean;
  /** Declared with `content: application/json`: sent as one query value holding JSON text (a string is passed through as is) */
  json?: boolean;
}
interface BodySpec {
  contentType: 'application/json' | 'multipart/form-data';
  required: boolean;
  /** Body properties sit at the top level of the arguments (the keys left after removing path / query parameters are the body) */
  flatten: boolean;
  /** When not flattened, the argument key that holds the body */
  param?: string;
  /** Wrapped once more before sending: { [wrap]: payload } (for projection tools) */
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
  /** Properties of the arguments (including body properties when flattened); the runtime uses them to tell parameters from the body */
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

/**
 * A query parameter declared with `content: application/json` (filters / sort / metrics / dimensions / checks) travels as one
 * query value holding the JSON text of an array. openapi.yaml tells HTTP callers to `JSON.stringify` it themselves; here the
 * runtime does that (api.ts), so the tool takes the array itself, typed by the content schema, and the sentence about
 * stringifying is dropped from the description. The JSON text is accepted too: models pass either, and a tool that refuses one
 * of them costs a turn.
 */
const JSON_TEXT_PHRASE =
  /a JSON string holding an array of (.+? objects) \(`JSON\.stringify` the array; do not pass the array itself\)/g;

function jsonTextParam(media: Json): Json {
  const inner = (media.schema as Json | undefined) ?? { type: 'array' };
  const types = Array.isArray(inner.type) ? (inner.type as string[]) : [(inner.type as string | undefined) ?? 'array'];
  const schema: Json = { ...inner, type: [...new Set([...types, 'string'])] };
  if (!('examples' in schema) && Array.isArray(media.examples)) schema.examples = media.examples;
  return schema;
}

/** Turns one operation into {operation table entry, inputSchema, outputSchema}. bodyMode: flatten / the nesting key. */
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
    if (where !== 'path' && where !== 'query') continue; // header / cookie parameters are not exposed
    const name = p.name as string;
    const media = ((p.content as Record<string, Json> | undefined) ?? {})['application/json'];
    const schema = media ? jsonTextParam(media) : { ...((p.schema as Json) ?? { type: 'string' }) };
    // Append notes by components.parameters name (a shared parameter gets them in every operation that references it)
    const append =
      typeof rawParam.$ref === 'string' ? parameterOverrides[refName(rawParam.$ref)]?.descriptionAppend : undefined;
    const text = p.description as string | undefined;
    const original = media && text ? text.replace(JSON_TEXT_PHRASE, 'an array of $1') : text;
    const description = append ? `${(original ?? '').trimEnd()}\n${append.trim()}`.trim() : original;
    if (description) schema.description = description;
    if (p.example !== undefined && !('examples' in schema)) schema.examples = [p.example];
    properties[name] = schema;
    const isRequired = where === 'path' || p.required === true;
    if (isRequired) required.push(name);
    params.push({
      name,
      in: where,
      required: isRequired,
      array: (!media && schema.type === 'array') || undefined,
      json: media ? true : undefined
    });
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

  // success response -> outputSchema
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

/** Merges `allOf` into one object when every part is an object with properties (and no pointer stub), so it can be flattened. */
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

/** File upload: the binary field in multipart becomes a base64 triple, and the runtime rebuilds FormData from it. */
function multipartSchema(raw: Json): Json {
  const schema = structuredClone(raw ?? {});
  const props = (schema.properties ?? {}) as Json;
  const req = new Set((schema.required as string[]) ?? []);
  if ('file' in props) {
    const fileDesc = (((props.file as Json).description as string) ?? 'The file to upload').replace(/\.$/, '');
    delete props.file;
    req.delete('file');
    props.file_base64 = {
      type: 'string',
      description: `${fileDesc}. The file content as Base64 (a data URI prefix is fine).`
    };
    props.file_name = { type: 'string', description: 'File name, with extension' };
    props.content_type = { type: 'string', description: 'MIME type of the file, e.g. image/png, text/csv' };
    req.add('file_base64');
    req.add('file_name');
    req.add('content_type');
  }
  schema.properties = props;
  schema.required = [...req];
  return schema;
}

function describe(built: Built, override: ToolOverride = {}, outputSchema = built.outputSchema): string {
  const parts = [built.summary, override.description?.trim() ?? built.operation.description];
  if (!outputSchema && built.operation.responseSchema) {
    parts.push(`Returns schema "${built.operation.responseSchema}" (see get_schema).`);
  }
  if (override.descriptionAppend) parts.push(override.descriptionAppend.trim());
  return parts.filter(Boolean).join('\n');
}

// Runtime operation table: every operation, all flattened (composite tools pass body keys directly in code)
const operations: Record<string, OperationSpec> = {};
for (const operationId of rawOps.keys()) operations[operationId] = buildOperation(operationId, 'flatten').operation;

// ---------- tools ----------

const tools: ToolSpec[] = [];

for (const [operationId, name] of Object.entries(overlay.include)) {
  const override = toolOverrides[operationId] ?? {};
  const built = buildOperation(operationId, bodyParam[operationId] ?? 'flatten');
  const outputSchema = override.outputSchema === false ? undefined : (built.outputSchema ?? undefined);
  tools.push({
    ...built.operation,
    name,
    title: override.title ?? (built.summary || operationId),
    description: describe(built, override, outputSchema),
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
      description: 'A form token, or an array of up to 10 tokens to count several forms in one call'
    };
    extra.push(`Several forms (form_token is an array): ${across.operation.description}`);
  } else {
    if (!composite.settingOperation || !composite.settingKey || !composite.scene) {
      throw new Error(`composite ${name}: scene / settingOperation / settingKey are required`);
    }
    const setting = buildOperation(composite.settingOperation, 'flatten');
    delete properties.scene;
    if (composite.kind === 'scene_form_create') {
      // Models pass scene to these tools whatever the description says: accept it, pinned to the tool's own
      // scene (composites.ts sets it anyway), instead of refusing the call and costing a turn.
      properties.scene = {
        type: 'string',
        const: composite.scene,
        description: `Always "${composite.scene}"; this tool sets it, so it can be left out`
      };
    }
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
      description: `${composite.scene === 'exam' ? 'Exam' : 'Evaluation'} settings (${composite.settingOperation}): ${setting.operation.description}`
    };
    extra.push(built.operation.description);
  }
  tools.push({
    ...built.operation,
    name,
    title: composite.title ?? name,
    description: [composite.description?.trim(), ...extra].filter(Boolean).join('\n'),
    inputSchema,
    // The multi-form count response is small and ships with tools/list; an exam / evaluation form response is the whole Form, too large.
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

// Names are unique and valid (MCP recommends ^[a-zA-Z0-9_-]{1,128}$)
const names = new Set<string>();
for (const tool of tools) {
  if (!/^[a-z0-9_]{1,64}$/.test(tool.name)) throw new Error(`bad tool name: ${tool.name}`);
  if (names.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
  names.add(tool.name);
}

// ---------- schema catalog (for get_schema / resources) ----------

/** A component schema: inlined up to other pointer schemas; the schema itself is neither replaced by a pointer nor collapsed. */
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
        `${(resolved.description as string) ?? ''}\nBranches on type: x-variants maps each type to its branch schema; get_schema shows a branch (e.g. "TextFieldInput").`.trim();
    }
    return resolved;
  } finally {
    collapseMin = savedCollapse;
    if (wasPointer) pointer.add(name);
  }
}

const schemaCatalog: Record<string, Json> = {};
for (const name of Object.keys(schemas).sort()) schemaCatalog[name] = componentSchema(name);

// ---------- output ----------

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
