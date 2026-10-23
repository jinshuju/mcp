/**
 * The sample set: evals/tasks/*.yaml, one category per file. Loading checks the basics, including that every fixture an assertion names exists.
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
      const where = `${file} › ${task.id ?? '(no id)'}`;
      if (!task.id || typeof task.id !== 'string') throw new Error(`${where}: missing id`);
      if (ids.has(task.id)) throw new Error(`${where}: duplicate id`);
      ids.add(task.id);
      if (!CATEGORIES.includes(task.category))
        throw new Error(`${where}: category must be one of ${CATEGORIES.join(' / ')}`);
      if (!task.prompt?.trim()) throw new Error(`${where}: empty prompt`);
      if (!task.expect || typeof task.expect !== 'object') throw new Error(`${where}: missing expect`);
      for (const name of Object.keys(task.files ?? {})) {
        if (!/^[^/\\]+$/.test(name) || name === '.' || name === '..')
          throw new Error(`${where}: file name ${name} must be a plain name`);
      }
      const aliases = new Set(spec?.forms.map((f) => f.alias) ?? []);
      if (spec) {
        for (const alias of task.fixtures ?? []) {
          if (!aliases.has(alias)) throw new Error(`${where}: no fixture ${alias}`);
        }
        for (const check of task.expect.state ?? []) {
          const alias = 'fixture' in check ? check.fixture : undefined;
          if (alias && !aliases.has(alias))
            throw new Error(`${where}: a state assertion names a missing fixture ${alias}`);
          if (check.check === 'form_created' && check.same_field_count_as && !aliases.has(check.same_field_count_as)) {
            throw new Error(`${where}: same_field_count_as names a missing fixture ${check.same_field_count_as}`);
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
  /** Samples n tasks (with a fixed seed, so it repeats) */
  sample?: number;
}

export function selectTasks(tasks: Task[], options: TaskFilterOptions): Task[] {
  let out = tasks;
  if (options.ids?.length) {
    const want = new Set(options.ids);
    out = out.filter((t) => want.has(t.id));
    const missing = options.ids.filter((id) => !tasks.some((t) => t.id === id));
    if (missing.length) throw new Error(`No such tasks: ${missing.join(', ')}`);
  }
  if (options.categories?.length) {
    const want = new Set(options.categories);
    out = out.filter((t) => want.has(t.category));
  }
  if (options.sample && options.sample < out.length) {
    // Deterministic sample: sort by a simple hash of the id and take the first n, so the same arguments give the same sample
    const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    out = [...out].sort((a, b) => hash(a.id) - hash(b.id)).slice(0, options.sample);
  }
  return out;
}
