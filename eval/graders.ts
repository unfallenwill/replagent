import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { workspacePath } from './files.js';
import type { Answer, CheckResult, EvalCheck, EvalTask } from './types.js';

export async function grade(
  task: EvalTask,
  cwd: string,
  answers: readonly Answer[],
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of task.checks) {
    try {
      results.push(await checkResult(task, check, cwd, answers));
    } catch (error) {
      results.push({
        id: check.id,
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function checkResult(
  task: EvalTask,
  check: EvalCheck,
  cwd: string,
  answers: readonly Answer[],
): Promise<CheckResult> {
  if (check.type === 'node') {
    return nodeCheck(check, cwd);
  }
  if (check.type === 'answer') {
    const text = answers
      .filter((answer) => check.turn === undefined || answer.turn === check.turn)
      .map((answer) => answer.text)
      .join('\n');
    return verdict(
      check.id,
      text.includes(check.includes),
      `Expected answer to include ${check.includes}`,
    );
  }
  const target = workspacePath(cwd, check.path);
  if (check.type === 'absent') {
    return absent(check.id, target);
  }
  const actual = await readFile(target, 'utf8');
  if (check.type === 'json') {
    return verdict(
      check.id,
      isDeepStrictEqual(JSON.parse(actual), check.value),
      `JSON differs: ${actual}`,
    );
  }
  const expected = check.type === 'unchanged' ? task.fixtures[check.path] : check.content;
  return verdict(
    check.id,
    actual === expected,
    `File differs: ${check.path}\n${actual.slice(0, 2000)}`,
  );
}

function verdict(id: string, passed: boolean, failure: string): CheckResult {
  return { id, passed, detail: passed ? 'ok' : failure };
}

async function absent(id: string, target: string): Promise<CheckResult> {
  try {
    await readFile(target);
    return verdict(id, false, 'File should not exist.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return verdict(id, true, '');
    }
    throw error;
  }
}

/** Trusted tests run after the agent process is stopped, outside its transcript. */
function nodeCheck(check: Extract<EvalCheck, { type: 'node' }>, cwd: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', check.code], {
      cwd,
      windowsHide: true,
      env: cleanEnvironment(),
      timeout: check.timeoutMs ?? 10_000,
      killSignal: 'SIGKILL',
    });
    let output = '';
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(0, 8000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => resolve(verdict(check.id, false, error.message)));
    child.on('close', (code) =>
      resolve(verdict(check.id, code === 0, output || `Grader exited: ${code}`)),
    );
  });
}

/** In particular, no provider credentials or user Node preload settings. */
export function cleanEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
  ]) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  return env;
}
