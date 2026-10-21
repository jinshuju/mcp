#!/usr/bin/env tsx
/**
 * npm run eval -- <command> [options]
 *
 *   seed [--reset]                       Prepare the fixtures (forms + entries) in the eval account; writes state/fixtures.json
 *   run [options]                        Run the matrix; by default every task × EVAL_MODELS against this repo's MCP
 *       --models a,b  --mcp new,name=url  --tasks id,id  --category 读数据,统计汇总  --sample n
 *       --repeat n  --concurrency n  --judge model  --run-id id  --resume  --verbose  --no-upload
 *       --description-limit n            Truncate tool descriptions to n characters (for gateways with a 1024 limit)
 *       --min-pass-rate n                Exit 1 when the run's pass rate is under n percent (default EVAL_MIN_PASS_RATE; unset never fails)
 *   report <run_id>                      Write report.md / summary.json
 *   upload <run_id>                      Write the results into the Jinshuju results form
 *   reset [alias...]                     Restore fixtures to what fixtures.yaml describes
 *   sweep [--hours n]                    Move non-fixture forms created in the last n hours into the output folder
 *   tasks                                List the sample set
 *   catalog                              Connect to the MCP(s) and print the version, tool count and catalog size
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
import { readRecords, runMatrix } from './runner.js';
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
      log(`Fixtures ready: ${Object.keys(state.forms).length} forms, state in ${cfg.stateDir}/fixtures.json`);
      for (const f of Object.values(state.forms)) log(`  ${f.alias.padEnd(14)} ${f.token}  ${f.name}  ${f.url}`);
      return;
    }
    case 'reset': {
      const { api } = await makeApi(cfg);
      const state = requireState(cfg);
      const aliases = positional.length ? positional : Object.keys(state.forms);
      for (const alias of aliases) {
        log(`Resetting ${alias}`);
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
      log(`Moved ${moved.length} forms`);
      return;
    }
    case 'tasks': {
      const tasks = selectTasks(loadTasks(spec), { ids: list(flags.tasks), categories: list(flags.category) });
      for (const t of tasks) {
        log(
          `${t.id.padEnd(10)} ${t.category.padEnd(5)} ${t.title}${t.writes ? '  [writes]' : ''}${t.creates_forms ? '  [creates forms]' : ''}  fixtures=${(t.fixtures ?? []).join(',') || '-'}`
        );
      }
      log(`${tasks.length} tasks`);
      return;
    }
    case 'catalog': {
      const { credential } = await makeApi(cfg);
      for (const target of parseTargets(list(flags.mcp) ?? ['new'], cfg)) {
        const mcp = await connectMcp(target, credential, cfg);
        log(`${target.name}: ${mcp.version}`);
        log(
          `  ${mcp.tools.length} tools, tools/list ${mcp.catalog_chars} chars, instructions ${mcp.instructions?.length ?? 0} chars`
        );
        const long = mcp.tools.filter((t) => (t.description?.length ?? 0) > 1024).length;
        log(`  Tools with a description over 1024 chars: ${long}`);
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
      if (!tasks.length) throw new Error('No tasks selected');
      const models = list(flags.models) ?? cfg.models;
      const targets = parseTargets(list(flags.mcp) ?? ['new'], cfg);
      const runId = str(flags['run-id']) ?? newRunId();
      const runDir = resolve(cfg.resultsDir, runId);
      mkdirSync(runDir, { recursive: true });
      await runMatrix({
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
      log(markdown.split('\n## Tasks')[0]!);
      log(`Report: ${resolve(runDir, 'report.md')}`);
      if (!flags['no-upload']) {
        try {
          const res = await uploadRun(api, cfg, spec, state, runDir, log);
          log(`Results written to the Jinshuju form: ${res.url} (${res.uploaded} entries)`);
        } catch (error) {
          log(`⚠ Writing the results form failed: ${(error as Error).message}`);
        }
      }
      // The whole run, including what earlier `--resume` phases did
      const records = readRecords(runDir);
      const passed = records.filter((r) => r.passed).length;
      const rate = records.length ? (100 * passed) / records.length : 0;
      log(`Done: ${passed}/${records.length} passed (${Math.round(rate)}%)`);
      const minPassRate = str(flags['min-pass-rate']) ? num(flags['min-pass-rate'], 0) : cfg.minPassRate;
      if (minPassRate !== undefined && rate < minPassRate) {
        log(`Pass rate ${Math.round(rate)}% is under the ${minPassRate}% floor (--min-pass-rate / EVAL_MIN_PASS_RATE)`);
        process.exitCode = 1;
      }
      return;
    }
    case 'report': {
      const id = positional[0];
      if (!id) throw new Error('Usage: report <run_id>');
      const { markdown } = writeReport(runDirFor(cfg, id));
      log(markdown);
      return;
    }
    case 'upload': {
      const id = positional[0];
      if (!id) throw new Error('Usage: upload <run_id>');
      const { api } = await makeApi(cfg);
      const state = requireState(cfg);
      const res = await uploadRun(api, cfg, spec, state, runDirFor(cfg, id), log);
      log(`Results form: ${res.url} (${res.uploaded} entries written this time)`);
      return;
    }
    default:
      log(
        'Usage: npm run eval -- <seed|run|report|upload|reset|sweep|tasks|catalog> [options] (see the comment at the top of evals/src/cli.ts)'
      );
      if (command !== 'help') process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
