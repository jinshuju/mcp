/**
 * 生成产物（src/generated/*.json）的形状。改这里要同步改 scripts/generate.ts。
 */
export type JsonSchema = Record<string, unknown>;

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface ParamSpec {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  /** query 数组按 Rails 习惯序列化成 name[]=a&name[]=b */
  array?: boolean;
}

export interface BodySpec {
  contentType: 'application/json' | 'multipart/form-data';
  required: boolean;
  /** 请求体属性在入参顶层：去掉 path / query 参数后的其余键就是请求体 */
  flatten: boolean;
  /** 不 flatten 时，请求体在入参里的键名 */
  param?: string;
  /** 发出前再包一层 { [wrap]: payload }（投影工具用） */
  wrap?: string;
}

/** openapi 的一个操作：运行时发请求所需的一切 */
export interface OperationSpec {
  operationId: string;
  summary: string;
  description: string;
  tag: string;
  method: HttpMethod;
  path: string;
  params: ParamSpec[];
  paramNames: string[];
  body?: BodySpec;
  successStatus: number;
  scopes: string[];
  responseSchema?: string;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type CompositeKind = 'scene_form_create' | 'scene_form_update' | 'count_entries';

/** 一个 MCP 工具：一个操作 + 入参 / 出参 schema；组合工具额外带 composite */
export interface ToolSpec extends OperationSpec {
  name: string;
  title: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations: ToolAnnotations;
  composite?: { kind: CompositeKind; scene?: string; settingOperation?: string; settingKey?: string };
}

export interface GeneratedMeta {
  generatedFrom: { title: string; version: string; sha256: string };
  baseUrl: string;
  toolCount: number;
  operationCount: number;
  /** 工具名 -> operationId（组合工具为 a+b） */
  tools: Record<string, string>;
  pointerSchemas: string[];
  omitSchemas: string[];
  tags: Record<string, string>;
}
