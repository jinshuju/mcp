/**
 * The shape of the generated output (src/generated/*.json). A change here needs the same change in scripts/generate.ts.
 */
export type JsonSchema = Record<string, unknown>;

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface ParamSpec {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  /** A query array is serialized as name[]=a&name[]=b (the server reads it as an array) */
  array?: boolean;
}

export interface BodySpec {
  contentType: 'application/json' | 'multipart/form-data';
  required: boolean;
  /** Body properties sit at the top level of the arguments: the keys left after removing path / query parameters are the body */
  flatten: boolean;
  /** When not flattened, the argument key that holds the body */
  param?: string;
  /** Wrapped once more as { [wrap]: payload } before sending (for projection tools) */
  wrap?: string;
}

/** One openapi operation: everything needed to send its request at runtime */
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

/** One MCP tool: an operation + input / output schemas; a composite tool also carries composite */
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
  /** Tool name -> operationId (a+b for a composite tool) */
  tools: Record<string, string>;
  pointerSchemas: string[];
  omitSchemas: string[];
  tags: Record<string, string>;
}
