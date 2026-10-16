/**
 * Tool argument validator: behaves the same on Node and Workers, and its errors name the argument at fault.
 *
 * On Node the SDK uses Ajv by default, which reports an extra key only as "data must NOT have additional properties"
 * without naming it, leaving the model to guess and drop keys one at a time. This uses the pure-JS @cfworker/json-schema
 * engine everywhere (it is what Workers uses anyway), and checks for extra top-level keys before the engine, listing the
 * extra and the accepted argument names directly.
 */
import type { JsonSchemaType, JsonSchemaValidatorResult, jsonSchemaValidator } from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';

const engine = new CfWorkerJsonSchemaValidator({ shortcircuit: false });

/**
 * The intent argument PostHog MCP analytics (analytics.ts) adds to every tool. The model fills it from the tool list, which
 * may be cached: clients keep sending it after analytics is turned off, so validation always accepts and strips it, on or
 * off, and it never reaches the API.
 */
export const CONTEXT_ARGUMENT = 'context';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Engine errors look like `#/limit: Instance type "string" is invalid. Expected "integer".`; this turns the JSON pointer
 * into an argument path, and drops the vague outer errors the engine adds after a sub-schema fails ("Property x does not
 * match schema" and the like).
 */
const NOISE = [/^Property "[^"]+" does not match (additional properties )?schema\.$/, /^False boolean schema\.$/];

function readable(message: string | undefined): string {
  if (!message) return 'Invalid arguments';
  const lines = message
    .split('; ')
    .map((line) =>
      line.replace(/^#\/?([^:]*):\s*/, (_m, path: string) => (path ? `${path.replace(/\//g, '.')}: ` : ''))
    );
  const specific = lines.filter((line) => !NOISE.some((re) => re.test(line.replace(/^[^:]*: /, ''))));
  return [...new Set(specific.length > 0 ? specific : lines)].join('; ');
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
            errorMessage: `Unknown arguments: ${extra.join(', ')}. This tool accepts only: ${known.join(', ')}`
          };
        }
      }
      const result = validate(input);
      if (result.valid) return result;
      return { valid: false, data: undefined, errorMessage: readable(result.errorMessage) };
    };
  }
};
