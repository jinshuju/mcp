/**
 * 工具入参校验器：在 Node 与 Workers 里行为一致，报错能指出是哪个参数出了问题。
 *
 * SDK 在 Node 上缺省用 Ajv，多传了键只会报 "data must NOT have additional properties"，不说是哪个键；
 * 模型只能逐个猜着删。这里统一用纯 JS 的 @cfworker/json-schema 引擎（Workers 上本来就是它），
 * 并先于引擎检查顶层多余键，直接列出多余的和可用的参数名。
 */
import type { JsonSchemaType, JsonSchemaValidatorResult, jsonSchemaValidator } from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';

const engine = new CfWorkerJsonSchemaValidator({ shortcircuit: false });

/**
 * PostHog MCP analytics（analytics.ts）给每个工具加的意图参数。模型照着工具列表填，而列表可能是它缓存的：
 * 埋点关掉之后客户端还会继续发，所以不管开没开，到了校验这里一律接受并去掉，不让它流到 API。
 */
export const CONTEXT_ARGUMENT = 'context';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 引擎的报错形如 `#/limit: Instance type "string" is invalid. Expected "integer".`，把 JSON pointer 换成参数路径；
 * 同时去掉引擎在子 schema 失败后顺带给出的外层笼统报错（"Property x does not match schema" 之类）。
 */
const NOISE = [/^Property "[^"]+" does not match (additional properties )?schema\.$/, /^False boolean schema\.$/];

function readable(message: string | undefined): string {
  if (!message) return '参数不合法';
  const lines = message
    .split('; ')
    .map((line) =>
      line.replace(/^#\/?([^:]*):\s*/, (_m, path: string) => (path ? `${path.replace(/\//g, '.')}：` : ''))
    );
  const specific = lines.filter((line) => !NOISE.some((re) => re.test(line.replace(/^.*：/, ''))));
  return [...new Set(specific.length > 0 ? specific : lines)].join('；');
}

export const toolInputValidator: jsonSchemaValidator = {
  getValidator<T>(schema: JsonSchemaType): (input: unknown) => JsonSchemaValidatorResult<T> {
    const validate = engine.getValidator<T>(schema);
    const known = Object.keys((schema.properties as Record<string, unknown> | undefined) ?? {});
    const strict = schema.additionalProperties === false;
    const stripContext = !known.includes(CONTEXT_ARGUMENT);
    return (raw) => {
      let input = raw;
      if (stripContext && isRecord(raw) && CONTEXT_ARGUMENT in raw) {
        const { [CONTEXT_ARGUMENT]: _context, ...rest } = raw;
        input = rest;
      }
      if (strict && isRecord(input)) {
        const extra = Object.keys(input).filter((key) => !known.includes(key));
        if (extra.length > 0) {
          return {
            valid: false,
            data: undefined,
            errorMessage: `不存在的参数：${extra.join('、')}。这个工具只接受：${known.join('、')}`
          };
        }
      }
      const result = validate(input);
      if (result.valid) return result;
      return { valid: false, data: undefined, errorMessage: readable(result.errorMessage) };
    };
  }
};
