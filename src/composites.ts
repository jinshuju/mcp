/**
 * Composite tools: one call sends two requests: creating and editing exam / evaluation forms, and counting across forms.
 * The generator assembles their input schema from openapi; this file only orchestrates: which request goes first, and what
 * to say when one fails.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiResponse } from './api.js';
import { toToolResult, type ToolRuntime } from './tools.js';
import type { OperationSpec, ToolSpec } from './types.js';
import operationsJson from './generated/operations.json' with { type: 'json' };

export const OPERATIONS = operationsJson as Record<string, OperationSpec>;

type Args = Record<string, unknown>;

function op(id: string): OperationSpec {
  const spec = OPERATIONS[id];
  if (!spec) throw new Error(`${id} is not in operations.json`);
  return spec;
}

function ok(res: ApiResponse): boolean {
  return res.status >= 200 && res.status < 300;
}

/**
 * Arguments of the scene setting operation: an operation with a flattened body takes the setting keys at the top level;
 * one whose body is a single schema (such as updateEvaluationSetting's EvaluationSettingInput pointer) takes them under
 * the body.param key. Both follow the operation table; nothing is guessed here.
 */
function settingArgs(settingOp: OperationSpec, formToken: unknown, setting: Args): Args {
  if (!settingOp.body || settingOp.body.flatten) return { form_token: formToken, ...setting };
  return { form_token: formToken, [settingOp.body.param ?? 'body']: setting };
}

function withText(result: CallToolResult, text: string): CallToolResult {
  const first = result.content[0];
  if (first?.type === 'text') first.text = `${text}\n${first.text}`;
  return result;
}

export async function runComposite(tool: ToolSpec, args: Args, runtime: ToolRuntime): Promise<CallToolResult> {
  const { api, credential, maxResultChars } = runtime;
  const composite = tool.composite!;

  if (composite.kind === 'count_entries') {
    const tokens = args.form_token;
    if (Array.isArray(tokens)) {
      const { form_token: _ignored, ...rest } = args;
      const res = await api.call(op('countEntriesAcrossForms'), { ...rest, form_tokens: tokens.join(',') }, credential);
      return toToolResult(tool, res, maxResultChars);
    }
    return toToolResult(tool, await api.call(op('countEntries'), args, credential), maxResultChars);
  }

  const settingKey = composite.settingKey!;
  const settingOp = op(composite.settingOperation!);
  const settingsUpdated = `${composite.scene === 'exam' ? 'Exam' : 'Evaluation'} settings updated.`;
  const { [settingKey]: setting, ...formArgs } = args;
  const hasSetting = !!setting && typeof setting === 'object' && Object.keys(setting as Args).length > 0;

  if (composite.kind === 'scene_form_create') {
    // Create the form first (to get its token), then write the scene settings; if the settings are rejected the form already exists, and the result must say so, or the caller creates another one.
    const created = await api.call(op('createForm'), { ...formArgs, scene: composite.scene }, credential);
    if (!ok(created)) return toToolResult(tool, created, maxResultChars);
    const token = (created.json as { token?: string } | undefined)?.token;
    if (!hasSetting || !token) return toToolResult(tool, created, maxResultChars);
    const updated = await api.call(settingOp, settingArgs(settingOp, token, setting as Args), credential);
    if (!ok(updated)) {
      const failure = toToolResult(tool, updated, maxResultChars);
      return withText(
        failure,
        `The form was created (token=${token}), but its ${composite.scene} settings were rejected; retry ${settingKey} alone with edit_${composite.scene}_form.`
      );
    }
    return withText(toToolResult(tool, created, maxResultChars), `${settingsUpdated} Form:`);
  }

  // scene_form_update: the settings go first (they are the half that may be rejected: a form not in that scene); if they are rejected, none of the other changes are sent.
  const formToken = formArgs.form_token;
  const hasFormChanges = Object.keys(formArgs).some((k) => k !== 'form_token' && formArgs[k] !== undefined);
  let settingResult: ApiResponse | undefined;
  if (hasSetting) {
    settingResult = await api.call(settingOp, settingArgs(settingOp, formToken, setting as Args), credential);
    if (!ok(settingResult)) return toToolResult(tool, settingResult, maxResultChars);
  }
  if (!hasFormChanges) {
    return settingResult
      ? withText(toToolResult(tool, settingResult, maxResultChars), settingsUpdated)
      : { isError: true, content: [{ type: 'text', text: `Nothing to change: pass ${settingKey} or form fields.` }] };
  }
  const updated = await api.call(op('updateForm'), formArgs, credential);
  const result = toToolResult(tool, updated, maxResultChars);
  if (settingResult) {
    return withText(
      result,
      ok(updated) ? `${settingsUpdated} Form:` : `${settingsUpdated} The form changes were rejected:`
    );
  }
  return result;
}
