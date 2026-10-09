/**
 * 组合工具：一次调用发两个请求：考试 / 测评表单的建与改、多表单计数。
 * 入参 schema 由生成器从 openapi 拼出，这里只有编排：先发哪个、失败了怎么说。
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
  if (!spec) throw new Error(`operations.json 里没有 ${id}`);
  return spec;
}

function ok(res: ApiResponse): boolean {
  return res.status >= 200 && res.status < 300;
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
  const sceneName = composite.scene === 'exam' ? '考试' : '测评';
  const { [settingKey]: setting, ...formArgs } = args;
  const hasSetting = !!setting && typeof setting === 'object' && Object.keys(setting as Args).length > 0;

  if (composite.kind === 'scene_form_create') {
    // 先建表单（拿到 token），再写场景设置；设置被拒绝时表单已存在，必须说清楚，免得调用方再建一个。
    const created = await api.call(op('createForm'), { ...formArgs, scene: composite.scene }, credential);
    if (!ok(created)) return toToolResult(tool, created, maxResultChars);
    const token = (created.json as { token?: string } | undefined)?.token;
    if (!hasSetting || !token) return toToolResult(tool, created, maxResultChars);
    const updated = await api.call(settingOp, { form_token: token, ...(setting as Args) }, credential);
    if (!ok(updated)) {
      const failure = toToolResult(tool, updated, maxResultChars);
      return withText(
        failure,
        `表单已创建（token=${token}），但${sceneName}设置被拒绝，请用 edit_${composite.scene}_form 单独重试 ${settingKey}。`
      );
    }
    return withText(toToolResult(tool, created, maxResultChars), `${sceneName}设置已更新。表单：`);
  }

  // scene_form_update：设置先发（它是可能被拒绝的那一半：不是该场景的表单），被拒绝时其它改动一个都不发。
  const formToken = formArgs.form_token;
  const hasFormChanges = Object.keys(formArgs).some((k) => k !== 'form_token' && formArgs[k] !== undefined);
  let settingResult: ApiResponse | undefined;
  if (hasSetting) {
    settingResult = await api.call(settingOp, { form_token: formToken, ...(setting as Args) }, credential);
    if (!ok(settingResult)) return toToolResult(tool, settingResult, maxResultChars);
  }
  if (!hasFormChanges) {
    return settingResult
      ? withText(toToolResult(tool, settingResult, maxResultChars), `${sceneName}设置已更新。`)
      : { isError: true, content: [{ type: 'text', text: `没有要修改的内容：请传 ${settingKey} 或表单字段。` }] };
  }
  const updated = await api.call(op('updateForm'), formArgs, credential);
  const result = toToolResult(tool, updated, maxResultChars);
  if (settingResult) {
    return withText(
      result,
      ok(updated) ? `${sceneName}设置已更新。表单：` : `${sceneName}设置已更新，但表单修改被拒绝：`
    );
  }
  return result;
}
