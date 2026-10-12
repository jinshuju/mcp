/**
 * 样本集：evals/tasks/*.yaml，每个文件一个类别。加载时做基本校验，保证断言引用的夹具存在。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { EVALS_DIR } from './config.js';
import { CATEGORIES, type FixturesSpec, type Task } from './types.js';

export function loadTasks(spec?: FixturesSpec, dir = resolve(EVALS_DIR, 'tasks')): Task[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  const tasks: Task[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    const list = parse(readFileSync(resolve(dir, file), 'utf8')) as Task[] | null;
    if (!Array.isArray(list)) continue;
    for (const task of list) {
      const where = `${file} › ${task.id ?? '(无 id)'}`;
      if (!task.id || typeof task.id !== 'string') throw new Error(`${where}: 缺少 id`);
      if (ids.has(task.id)) throw new Error(`${where}: id 重复`);
      ids.add(task.id);
      if (!CATEGORIES.includes(task.category)) throw new Error(`${where}: category 必须是 ${CATEGORIES.join(' / ')}`);
      if (!task.prompt?.trim()) throw new Error(`${where}: prompt 为空`);
      if (!task.expect || typeof task.expect !== 'object') throw new Error(`${where}: 缺少 expect`);
      const aliases = new Set(spec?.forms.map((f) => f.alias) ?? []);
      if (spec) {
        for (const alias of task.fixtures ?? []) {
          if (!aliases.has(alias)) throw new Error(`${where}: 夹具 ${alias} 不存在`);
        }
        for (const check of task.expect.state ?? []) {
          const alias = 'fixture' in check ? check.fixture : undefined;
          if (alias && !aliases.has(alias)) throw new Error(`${where}: 状态断言引用了不存在的夹具 ${alias}`);
          if (check.check === 'form_created' && check.same_field_count_as && !aliases.has(check.same_field_count_as)) {
            throw new Error(`${where}: same_field_count_as 引用了不存在的夹具 ${check.same_field_count_as}`);
          }
        }
      }
      task.prompt = task.prompt.trim();
      tasks.push(task);
    }
  }
  return tasks;
}

export interface TaskFilterOptions {
  ids?: string[];
  categories?: string[];
  /** 随机抽样 n 个（固定种子，便于复现） */
  sample?: number;
}

export function selectTasks(tasks: Task[], options: TaskFilterOptions): Task[] {
  let out = tasks;
  if (options.ids?.length) {
    const want = new Set(options.ids);
    out = out.filter((t) => want.has(t.id));
    const missing = options.ids.filter((id) => !tasks.some((t) => t.id === id));
    if (missing.length) throw new Error(`没有这些任务：${missing.join(', ')}`);
  }
  if (options.categories?.length) {
    const want = new Set(options.categories);
    out = out.filter((t) => want.has(t.category));
  }
  if (options.sample && options.sample < out.length) {
    // 确定性抽样：按 id 的简单哈希排序后取前 n，保证同样的参数得到同样的样本
    const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    out = [...out].sort((a, b) => hash(a.id) - hash(b.id)).slice(0, options.sample);
  }
  return out;
}
