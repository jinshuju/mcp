/**
 * Runs the matrix: tasks × models × MCPs (× repeats). Write tasks lock their fixture and reset it before and after; once every job is done, the forms the run created are deleted.
 * Each run writes results/<run_id>/{meta.json, runs.jsonl, transcripts/*.json} and can be picked up again with --resume.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Credential } from '../../src/credential.js';
import { META } from '../../src/server.js';
import { runAgent } from './agent.js';
import { EvalApi } from './api.js';
import { evaluateTask } from './assertions.js';
import type { EvalConfig } from './config.js';
import { resetFixture, sweepCreatedForms } from './fixtures.js';
import type { LlmConfig } from './llm.js';
import { connectMcp, type McpTarget } from './mcp.js';
import { createWorkdir } from './shell.js';
import type { FixtureState, FixturesSpec, RunMeta, RunRecord, Task } from './types.js';

/** Read-write lock: read tasks run together, a write task runs alone; FIFO, so nothing starves. */
class RWLock {
  private readers = 0;
  private writer = false;
  private readonly waiters: { write: boolean; resolve: () => void }[] = [];

  private canGrant(write: boolean): boolean {
    return write ? !this.writer && this.readers === 0 : !this.writer;
  }

  acquire(write: boolean): Promise<void> {
    if (!this.waiters.length && this.canGrant(write)) {
      if (write) this.writer = true;
      else this.readers++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push({ write, resolve }));
  }

  release(write: boolean): void {
    if (write) this.writer = false;
    else this.readers--;
    while (this.waiters.length && this.canGrant(this.waiters[0]!.write)) {
      const next = this.waiters.shift()!;
      if (next.write) this.writer = true;
      else this.readers++;
      next.resolve();
    }
  }
}

export interface RunOptions {
  cfg: EvalConfig;
  credential: Credential;
  api: EvalApi;
  spec: FixturesSpec;
  state: FixtureState;
  tasks: Task[];
  models: string[];
  targets: McpTarget[];
  repeat: number;
  concurrency: number;
  judgeModel: string;
  runDir: string;
  resume?: boolean;
  /** OpenAI's function description limit (characters); undefined means no truncation */
  descriptionLimit?: number;
  verbose?: boolean;
  log?: (line: string) => void;
}

interface Job {
  id: string;
  task: Task;
  model: string;
  target: McpTarget;
  repeat: number;
}

export function runsPath(runDir: string): string {
  return resolve(runDir, 'runs.jsonl');
}

export function readRecords(runDir: string): RunRecord[] {
  const path = runsPath(runDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunRecord);
}

export function readMeta(runDir: string): RunMeta {
  return JSON.parse(readFileSync(resolve(runDir, 'meta.json'), 'utf8')) as RunMeta;
}

function sanitize(id: string): string {
  return id.replace(/[^\w.-]+/g, '_');
}

export async function runMatrix(options: RunOptions): Promise<RunRecord[]> {
  const { cfg, credential, api, spec, state, tasks, models, targets, runDir } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const runId = basename(runDir);
  mkdirSync(resolve(runDir, 'transcripts'), { recursive: true });
  const llm: LlmConfig = { baseUrl: cfg.llmBaseUrl, apiKey: cfg.llmApiKey, timeoutMs: cfg.llmTimeoutMs };

  // Describe each MCP under test (version, catalog size)
  const described: RunMeta['targets'] = [];
  for (const target of targets) {
    const mcp = await connectMcp(target, credential, cfg);
    described.push({
      name: target.name,
      kind: target.kind,
      url: target.url,
      version: mcp.version,
      tool_count: mcp.tools.length,
      catalog_chars: mcp.catalog_chars
    });
    await mcp.close();
    log(`MCP ${target.name}: ${mcp.version}, ${mcp.tools.length} tools, catalog ${mcp.catalog_chars} chars`);
  }
  const meta: RunMeta = {
    run_id: runId,
    started_at: new Date().toISOString(),
    models,
    targets: described,
    judge_model: options.judgeModel,
    task_count: tasks.length,
    repeat: options.repeat,
    git_commit: described.find((t) => t.kind === 'inprocess')?.version.match(/commit=(\w+)/)?.[1] ?? '',
    openapi_sha: META.generatedFrom.sha256,
    account: state.account,
    llm_base_url: cfg.llmBaseUrl
  };
  if (!(options.resume && existsSync(resolve(runDir, 'meta.json')))) {
    writeFileSync(resolve(runDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  }

  const done = new Set(options.resume ? readRecords(runDir).map((r) => r.job_id) : []);
  const jobs: Job[] = [];
  for (let r = 1; r <= options.repeat; r++) {
    for (const task of tasks) {
      for (const model of models) {
        for (const target of targets) {
          const id = `${task.id}|${model}|${target.name}|${r}`;
          if (done.has(id)) continue;
          jobs.push({ id, task, model, target, repeat: r });
        }
      }
    }
  }
  log(
    `Run ${runId}: ${jobs.length} jobs (${tasks.length} tasks × ${models.length} models × ${targets.length} MCPs × ${options.repeat})${done.size ? `, skipping ${done.size} already done` : ''}`
  );

  const locks = new Map<string, RWLock>();
  const lockFor = (alias: string) => {
    let l = locks.get(alias);
    if (!l) locks.set(alias, (l = new RWLock()));
    return l;
  };
  const appendLock = new RWLock();
  const records: RunRecord[] = [];
  let finished = 0;

  async function runJob(job: Job): Promise<void> {
    const { task, model, target } = job;
    const label = `${task.id} × ${model} × ${target.name}${options.repeat > 1 ? ` #${job.repeat}` : ''}`;
    const aliases = [...(task.fixtures ?? [])].sort();
    const write = !!task.writes;
    for (const alias of aliases) await lockFor(alias).acquire(write);
    const startedAt = new Date();
    const vlog = options.verbose ? (line: string) => log(`    ${line}`) : undefined;
    let record: RunRecord;
    try {
      if (write) for (const alias of aliases) await resetFixture(api, cfg, spec, state, alias, vlog);
      const mcp = await connectMcp(target, credential, cfg);
      const workdir = task.files ? createWorkdir(task.files) : undefined;
      let trace;
      try {
        trace = await runAgent({
          task,
          mcp,
          workdir,
          model,
          llm,
          maxTurns: task.max_turns ?? 12,
          maxToolResultChars: cfg.maxToolResultChars,
          toolTimeoutMs: cfg.toolTimeoutMs,
          descriptionLimit: options.descriptionLimit,
          log: vlog
        });
      } finally {
        await mcp.close().catch(() => {});
        workdir?.remove();
      }
      const assertions = await evaluateTask(task, trace, {
        api,
        state,
        spec,
        runStartedAt: startedAt,
        llm,
        judgeModel: options.judgeModel
      });
      const passed = assertions.every((a) => a.pass);
      const usage = trace.turn_usage.reduce(
        (acc, t) => ({
          prompt_tokens: acc.prompt_tokens + t.prompt_tokens,
          completion_tokens: acc.completion_tokens + t.completion_tokens,
          cached_tokens: acc.cached_tokens + t.cached_tokens,
          reasoning_tokens: acc.reasoning_tokens + t.reasoning_tokens
        }),
        { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 }
      );
      record = {
        run_id: runId,
        job_id: job.id,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        task_id: task.id,
        category: task.category,
        model,
        mcp: target.name,
        mcp_version: mcp.version,
        status: passed ? 'passed' : 'failed',
        passed,
        assertions,
        final_answer: trace.final_answer,
        turns: trace.turns,
        tool_calls: trace.tool_calls,
        tool_errors: trace.tool_errors,
        tool_retries: trace.tool_retries,
        llm_retries: trace.llm_retries,
        truncated_results: trace.truncated_results,
        exhausted: trace.exhausted,
        usage,
        turn_usage: trace.turn_usage,
        calls: trace.calls,
        duration_ms: Date.now() - startedAt.getTime(),
        judge_model: task.expect.answer?.claims?.length ? options.judgeModel : undefined,
        error: trace.error
      };
      writeFileSync(
        resolve(runDir, 'transcripts', `${sanitize(job.id)}.json`),
        JSON.stringify({ job_id: job.id, task: task.id, model, mcp: target.name, messages: trace.messages }, null, 2)
      );
      try {
        if (write) for (const alias of aliases) await resetFixture(api, cfg, spec, state, alias, vlog);
      } catch (error) {
        log(`  ⚠ ${label} cleanup failed: ${(error as Error).message}`);
      }
    } catch (error) {
      record = {
        run_id: runId,
        job_id: job.id,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        task_id: task.id,
        category: task.category,
        model,
        mcp: target.name,
        mcp_version: described.find((t) => t.name === target.name)?.version ?? '',
        status: 'error',
        passed: false,
        assertions: [],
        final_answer: '',
        turns: 0,
        tool_calls: 0,
        tool_errors: 0,
        tool_retries: 0,
        llm_retries: 0,
        truncated_results: 0,
        exhausted: false,
        usage: { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 },
        turn_usage: [],
        calls: [],
        duration_ms: Date.now() - startedAt.getTime(),
        error: (error as Error).stack ?? String(error)
      };
    } finally {
      for (const alias of aliases.toReversed()) lockFor(alias).release(write);
    }
    await appendLock.acquire(true);
    try {
      appendFileSync(runsPath(runDir), `${JSON.stringify(record)}\n`);
    } finally {
      appendLock.release(true);
    }
    records.push(record);
    finished++;
    const mark = record.status === 'passed' ? '✓' : record.status === 'failed' ? '✗' : '⚠';
    const why =
      record.status === 'passed'
        ? ''
        : ` — ${(
            record.error?.split('\n')[0] ??
            record.assertions
              .filter((a) => !a.pass)
              .map((a) => a.name)
              .slice(0, 3)
              .join('; ')
          ).slice(0, 160)}`;
    log(
      `[${finished}/${jobs.length}] ${mark} ${label}: ${record.turns} turns / ${record.tool_calls} tool calls / ${Math.round(record.duration_ms / 1000)}s / ${record.usage.prompt_tokens + record.usage.completion_tokens} tok${why}`
    );
  }

  const queue = [...jobs];
  const workers = Array.from({ length: Math.max(1, options.concurrency) }, async () => {
    while (queue.length) {
      const job = queue.shift()!;
      await runJob(job);
    }
  });
  await Promise.all(workers);
  // Not per job: jobs run concurrently, and the forms another job just created may not have been asserted on yet
  try {
    const deleted = await sweepCreatedForms(api, state, new Date(meta.started_at), log);
    if (deleted.length) log(`Deleted ${deleted.length} forms created during the run`);
  } catch (error) {
    log(`⚠ Deleting the forms created during the run failed: ${(error as Error).message}`);
  }
  meta.finished_at = new Date().toISOString();
  writeFileSync(resolve(runDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return records;
}
