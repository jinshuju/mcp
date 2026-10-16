/**
 * LLM-as-judge: an open answer is checked claim by claim against a rubric. The judge model is fixed and written into the results, so rounds can be compared.
 * The judge prompt stays in Chinese: the tasks, answers and claims are Chinese, and rewording it would break comparison with past rounds.
 */
import { chatCompletion, type LlmConfig } from './llm.js';

export interface ClaimVerdict {
  claim: string;
  pass: boolean;
  reason: string;
}

const SYSTEM = [
  '你是严格的评测裁判。给你一个用户任务、助手的最终答复，以及若干「应当成立的事实」。',
  '逐条判断答复是否明确、正确地支持该事实：',
  '- 数字要一致；事实里写了允许四舍五入的，按说明放宽，否则必须精确。',
  '- 答复没有提到、含糊其辞、或与事实矛盾，都算不通过。',
  '- 只看答复文本，不要替助手补算。',
  '输出 JSON：{"results":[{"index":1,"pass":true,"reason":"一句话"}...]}，index 从 1 起，与事实顺序一致，不要输出其它内容。'
].join('\n');

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('the judge returned no JSON');
  return JSON.parse(text.slice(start, end + 1));
}

export async function judgeClaims(
  llm: LlmConfig,
  model: string,
  input: { prompt: string; answer: string; claims: string[] }
): Promise<ClaimVerdict[]> {
  if (!input.claims.length) return [];
  if (!input.answer.trim()) {
    return input.claims.map((claim) => ({ claim, pass: false, reason: 'the assistant gave no final answer' }));
  }
  const user = [
    '## 用户任务',
    input.prompt,
    '',
    '## 助手的最终答复',
    input.answer,
    '',
    '## 应当成立的事实',
    ...input.claims.map((c, i) => `${i + 1}. ${c}`)
  ].join('\n');
  const res = await chatCompletion(llm, {
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user }
    ],
    extra: { temperature: 0 }
  });
  const text = res.message.content ?? '';
  let parsed: { results?: { index?: number; pass?: boolean; reason?: string }[] };
  try {
    parsed = extractJson(text) as typeof parsed;
  } catch (error) {
    return input.claims.map((claim) => ({
      claim,
      pass: false,
      reason: `cannot parse the judge's output: ${(error as Error).message}`
    }));
  }
  const byIndex = new Map((parsed.results ?? []).map((r, i) => [Number(r.index ?? i + 1), r]));
  return input.claims.map((claim, i) => {
    const r = byIndex.get(i + 1);
    return { claim, pass: r?.pass === true, reason: r?.reason ?? 'the judge gave no verdict' };
  });
}
