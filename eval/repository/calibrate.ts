import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT } from '../../src/app/prompt.js';
import { write } from '../long/helpers.js';
import { runEvaluation } from '../run.js';
import type { EvalConfig, EvalTask } from '../types.js';
import { SNAPSHOT } from './snapshot.js';
import { TASKS } from './tasks.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const files = 'src/adapters/toolkit/files.ts';
const toolkit = 'src/adapters/toolkit/toolkit.ts';
const original = SNAPSHOT.fixtures[files] ?? '';
const mutants = [
  write({
    [toolkit]: (SNAPSHOT.fixtures[toolkit] ?? '').replace(
      'export interface ReadOptions {',
      'export interface ReadOptions {\n readonly tail?: number;',
    ),
  }),
  write({
    [files]: original.replace(
      '  const lines = splitLines(text);',
      '  if(readOptions?.from===0)throw new RangeError("invalid");\n  const lines = splitLines(text);',
    ),
  }),
  write({
    'src/adapters/toolkit/read-text.ts': `export function countLines(text:string){if(!text)return 0;const a=text.split('\\n');if(a.length>1&&a.at(-1)==='')a.pop();return a.length;}export function selectReadText(text:string,o?:{from?:number,to?:number}){const a=text===''?[]:text.split('\\n');if(a.length>1&&a.at(-1)==='')a.pop();const f=o?.from??1,t=o?.to??a.length;return f>1||t<a.length?a.slice(Math.max(0,f-1),Math.min(a.length,Math.max(f,t))).join('\\n'):text;}`,
  }),
];

async function main(): Promise<void> {
  const tasks: EvalTask[] = TASKS.flatMap((task, index) => [
    {
      ...task,
      id: `calibration/noop/${index}`,
      checks: task.checks.filter((c) => c.id === 'hidden-contract'),
      reference: ['await step("claim","claim completion",async()=>{say("Done");});'],
    },
    {
      ...task,
      id: `calibration/mutant/${index}`,
      checks: task.checks.filter((c) => c.id === 'hidden-contract'),
      reference: [mutants[index] ?? ''],
    },
  ]);
  const config: EvalConfig = {
    mode: 'reference',
    model: 'reference-programs',
    endpoint: 'https://example.invalid',
    effort: 'max',
    trials: 1,
    concurrency: 2,
    budget: { timeoutMs: 60_000, maxCalls: 2, maxSteps: 2, maxTokens: 8192 },
    candidate: path.join(root, 'eval/candidate.ts'),
    systemPrompt: SYSTEM_PROMPT,
    out: path.resolve(root, process.argv[2] ?? '.evals/repository-calibration'),
  };
  const report = await runEvaluation({
    config,
    tasks,
    root,
    onTrial: (r) =>
      process.stdout.write(`${r.taskId}: ${r.passed ? 'UNEXPECTED PASS' : 'rejected'}\n`),
  });
  if (report.results.some((r) => r.passed || r.status !== 'completed'))
    throw new Error('Grader calibration failed.');
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
