#!/usr/bin/env tsx
/**
 * npm run eval -- <command> [options]
 *
 *   seed [--reset]                       在测评账户里准备夹具（表单 + 数据），写 state/fixtures.json
 *   run [options]                        跑矩阵；缺省全部任务 × EVAL_MODELS × new,builtin
 *       --models a,b  --mcp new,builtin  --tasks id,id  --category 读数据,统计汇总  --sample n
 *       --repeat n  --concurrency n  --judge model  --run-id id  --resume  --verbose  --no-upload
 *       --description-limit n            把工具描述截断到 n 字符（OpenAI 兼容网关有 1024 上限时用）
 *   report <run_id>                      生成 report.md / summary.json
 *   upload <run_id>                      把结果写进金数据表单
 *   reset [alias...]                     把夹具恢复成 fixtures.yaml 的样子
 *   sweep [--hours n]                    把最近 n 小时新建的非夹具表单移入「产出」文件夹
 *   tasks                                列出样本集
 *   catalog                              连上每个 MCP，打印版本、工具数、目录大小
 */
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { JinshujuApi } from '../../src/api.js';
import { resolveCredential } from '../../src/cli-credential.js';
import { configFromEnv } from '../../src/config.js';
import { VERSION } from '../../src/version.js';
import { EvalApi } from './api.js';
import { loadConfig, requireLlm, type EvalConfig } from './config.js';
import { loadFixturesSpec, requireState, resetFixture, seed, sweepCreatedForms } from './fixtures.js';
import { connectMcp, parseTargets } from './mcp.js';
import { writeReport } from './report.js';
import { runMatrix } from './runner.js';
import { loadTasks, selectTasks } from './tasks.js';
import { uploadRun } from './upload.js';

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < rest.length && !rest[i + 1]!.startsWith('--')) flags[a.slice(2)] = rest[++i]!;
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { command, positional, flags };
}

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);
const list = (v: string | boolean | undefined) =>
  str(v)
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const num = (v: string | boolean | undefined, fallback: number) => {
  const n = Number(str(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

async function makeApi(cfg: EvalConfig) {
  const credential = await resolveCredential();
  const apiCfg = configFromEnv();
  const api = new EvalApi(
    new JinshujuApi({
      baseUrl: apiCfg.apiBaseUrl,
      timeoutMs: apiCfg.timeoutMs,
      userAgent: `jinshuju-mcp-evals/${VERSION}`
    }),
    credential
  );
  void cfg;
  return { credential, api };
}

function runDirFor(cfg: EvalConfig, id: string): string {
  return existsSync(id) ? resolve(id) : resolve(cfg.resultsDir, id);
}

function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const log = (line: string) => console.log(line);
  const spec = loadFixturesSpec();

  switch (command) {
    case 'seed': {
      const { api } = await makeApi(cfg);
      const state = await seed(api, cfg, spec, { reset: !!flags.reset, log });
      log(`夹具就绪：${Object.keys(state.forms).length} 个表单，状态写在 ${cfg.stateDir}/fixtures.json`);
      for (const f of Object.values(state.forms)) log(`  ${f.alias.padEnd(14)} ${f.token}  ${f.name}  ${f.url}`);
      return;
    }
    case 'reset': {
      const { api } = await makeApi(cfg);
      const state = requireState(cfg);
      const aliases = positional.length ? positional : Object.keys(state.forms);
      for (const alias of aliases) {
        log(`重置 ${alias}`);
        await resetFixture(api, cfg, spec, state, alias, log);
      }
      return;
    }
    case 'sweep': {
      const { api } = await makeApi(cfg);
      const state = requireState(cfg);
      const hours = num(flags.hours, 24);
      const moved = await sweepCreatedForms(api, state, new Date(Date.now() - hours * 3_600_000), log);
      for (const m of moved) log(`  ${m.token}  ${m.name}`);
      log(`共移动 ${moved.length} 个表单`);
      return;
    }
    case 'tasks': {
      const tasks = selectTasks(loadTasks(spec), { ids: list(flags.tasks), categories: list(flags.category) });
      for (const t of tasks) {
        log(
          `${t.id.padEnd(10)} ${t.category.padEnd(5)} ${t.title}${t.writes ? '  [写]' : ''}${t.creates_forms ? '  [建表单]' : ''}  夹具=${(t.fixtures ?? []).join(',') || '-'}`
        );
      }
      log(`共 ${tasks.length} 个任务`);
      return;
    }
    case 'catalog': {
      const { credential } = await makeApi(cfg);
      for (const target of parseTargets(list(flags.mcp) ?? ['new', 'builtin'], cfg)) {
        const mcp = await connectMcp(target, credential, cfg);
        log(`${target.name}: ${mcp.version}`);
        log(
          `  工具 ${mcp.tools.length} 个，tools/list ${mcp.catalog_chars} 字符，instructions ${mcp.instructions?.length ?? 0} 字符`
        );
        const long = mcp.tools.filter((t) => (t.description?.length ?? 0) > 1024).length;
        log(`  描述超过 1024 字符的工具：${long} 个`);
        await mcp.close();
      }
      return;
    }
    case 'run': {
      requireLlm(cfg);
      const { credential, api } = await makeApi(cfg);
      const state = requireState(cfg);
      const tasks = selectTasks(loadTasks(spec), {
        ids: list(flags.tasks),
        categories: list(flags.category),
        sample: str(flags.sample) ? num(flags.sample, 0) : undefined
      });
      if (!tasks.length) throw new Error('没有选中任何任务');
      const models = list(flags.models) ?? cfg.models;
      const targets = parseTargets(list(flags.mcp) ?? ['new', 'builtin'], cfg);
      const runId = str(flags['run-id']) ?? newRunId();
      const runDir = resolve(cfg.resultsDir, runId);
      mkdirSync(runDir, { recursive: true });
      const records = await runMatrix({
        cfg,
        credential,
        api,
        spec,
        state,
        tasks,
        models,
        targets,
        repeat: num(flags.repeat, 1),
        concurrency: num(flags.concurrency, cfg.concurrency),
        judgeModel: str(flags.judge) ?? cfg.judgeModel,
        runDir,
        resume: !!flags.resume,
        descriptionLimit: str(flags['description-limit']) ? num(flags['description-limit'], 0) : undefined,
        verbose: !!flags.verbose,
        log
      });
      const { markdown } = writeReport(runDir);
      log('');
      log(markdown.split('\n## 任务明细')[0]!);
      log(`报告：${resolve(runDir, 'report.md')}`);
      if (!flags['no-upload']) {
        try {
          const res = await uploadRun(api, cfg, spec, state, runDir, log);
          log(`结果已写入金数据表单：${res.url}（${res.uploaded} 条）`);
        } catch (error) {
          log(`⚠ 写入结果表单失败：${(error as Error).message}`);
        }
      }
      const failed = records.filter((r) => !r.passed).length;
      log(`完成：${records.length - failed}/${records.length} 通过`);
      return;
    }
    case 'report': {
      const id = positional[0];
      if (!id) throw new Error('用法：report <run_id>');
      const { markdown } = writeReport(runDirFor(cfg, id));
      log(markdown);
      return;
    }
    case 'upload': {
      const id = positional[0];
      if (!id) throw new Error('用法：upload <run_id>');
      const { api } = await makeApi(cfg);
      const state = requireState(cfg);
      const res = await uploadRun(api, cfg, spec, state, runDirFor(cfg, id), log);
      log(`结果表单：${res.url}（本次写入 ${res.uploaded} 条）`);
      return;
    }
    default:
      log(
        '用法：npm run eval -- <seed|run|report|upload|reset|sweep|tasks|catalog> [options]（见 evals/src/cli.ts 顶部注释）'
      );
      if (command !== 'help') process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
