/**
 * A stand-in for the shell of an agent client (Claude Code, Cursor, Codex …), for tasks that hand the user's files to the model (`files`).
 * The files go into a fresh working directory, and the model gets one more tool, run_command, that runs curl / ls / cat / head / wc there:
 * enough for `curl -F file=@<path> <upload_url>` from a prepare_*_upload tool.
 * No shell parses the line (no pipes, redirection or variables), the environment carries no credentials,
 * and paths cannot leave the working directory, so a model's command cannot reach the eval's secrets from CI.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenAiTool } from './llm.js';

export const SHELL_TOOL = 'run_command';
const PROGRAMS = ['curl', 'ls', 'cat', 'head', 'wc'];
const MAX_OUTPUT_CHARS = 20_000;

export interface CommandOutcome {
  text: string;
  is_error: boolean;
  duration_ms: number;
}

export interface Workdir {
  dir: string;
  tool: OpenAiTool;
  run(command: string, timeoutMs: number): Promise<CommandOutcome>;
  remove(): void;
}

/** Splits a command line into argv the way a POSIX shell would for plain words and quotes; anything else a shell would act on is refused. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current: string | undefined;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      current ??= '';
    } else if (c === '\\' && i + 1 < command.length) {
      current = (current ?? '') + command[++i];
    } else if (/\s/.test(c)) {
      if (current !== undefined) args.push(current);
      current = undefined;
    } else if ('|;&<>`$(){}*?'.includes(c)) {
      throw new Error(`不支持 shell 语法（${c}）：一次只能执行一条命令，参数里的特殊字符请加引号`);
    } else {
      current = (current ?? '') + c;
    }
  }
  if (quote) throw new Error('引号没有闭合');
  if (current !== undefined) args.push(current);
  return args;
}

/** A path argument must stay inside the working directory: no absolute path, no `~`, no `..`; a URL must be http(s) (file:// is a path). */
function leavesWorkdir(arg: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(arg)?.[1];
  if (scheme) return !/^https?$/i.test(scheme);
  return /(^|[=@<])[/~]/.test(arg) || /(^|[/=@<])\.\.([/;]|$)/.test(arg);
}

export function createWorkdir(files: Record<string, string>): Workdir {
  const dir = mkdtempSync(join(tmpdir(), 'jinshuju-mcp-eval-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return {
    dir,
    tool: {
      type: 'function',
      function: {
        name: SHELL_TOOL,
        description: `在用户电脑上执行一条命令，工作目录里是用户的文件。只能用 ${PROGRAMS.join(' / ')}；命令不经过 shell，不支持管道、重定向和变量。`,
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: '要执行的命令，例如 ls -l' } },
          required: ['command']
        }
      }
    },
    run(command, timeoutMs) {
      const started = Date.now();
      const fail = (text: string): Promise<CommandOutcome> =>
        Promise.resolve({ text, is_error: true, duration_ms: Date.now() - started });
      let argv: string[];
      try {
        argv = splitCommand(command.trim());
      } catch (error) {
        return fail((error as Error).message);
      }
      const [program, ...args] = argv;
      if (!program) return fail('命令为空');
      if (!PROGRAMS.includes(program)) return fail(`只能用 ${PROGRAMS.join(' / ')}，不能用 ${program}`);
      const outside = args.find(leavesWorkdir);
      if (outside) return fail(`只能访问工作目录里的文件：${outside}`);
      return new Promise((resolveOutcome) => {
        execFile(
          program,
          args,
          {
            cwd: dir,
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8' },
            timeout: timeoutMs
          },
          (error, stdout, stderr) => {
            const code = error ? (typeof error.code === 'number' ? error.code : error.message) : 0;
            let text = [stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n' : '');
            if (code !== 0) text = `退出码 ${code}\n${text}`;
            if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n…（输出过长已截断）`;
            resolveOutcome({ text, is_error: code !== 0, duration_ms: Date.now() - started });
          }
        );
      });
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
