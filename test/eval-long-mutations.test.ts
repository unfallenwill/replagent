import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { functional, unit } from '../eval/long/helpers.js';
import { TASKS } from '../eval/long/tasks.js';
import { runEvaluation } from '../eval/run.js';
import type { EvalTask } from '../eval/types.js';
import {
  EVAL_ROOT,
  evalConfig,
  OUTPUT_TASK,
  program,
  required,
  SequenceLlm,
} from './eval-fixtures.js';

let directory = '';
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'replagent-mutation-test-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function replace(file: string, before: string, after: string): string {
  return `const fs=require('node:fs');const file=${JSON.stringify(file)};const before=fs.readFileSync(file,'utf8');const after=before.replace(${JSON.stringify(before)},${JSON.stringify(after)});if(after===before)throw Error('Mutation did not apply');fs.writeFileSync(file,after);say('Done');`;
}

const MUTATIONS: Readonly<Record<string, string>> = {
  'long/development/checkout-feature': replace(
    'src/pricing.mjs',
    'Math.round(subtotal*.10)',
    'Math.floor(subtotal*.10)',
  ),
  'long/development/csv-pipeline': replace('src/money.mjs', 'const s=text.trim()', 'const s=text'),
  'long/development/cache-migration': replace(
    'src/service.mjs',
    'read:id=>cache.getOrLoad(id,()=>fetcher(id))',
    'read:id=>fetcher(id)',
  ),
  'long/development/incremental-reconciliation': `const fs=require('node:fs');const r=JSON.parse(fs.readFileSync('reports/current.json','utf8'));r.orders.pop();fs.writeFileSync('reports/current.json',JSON.stringify(r));say('Done');`,
  'long/development/evolving-policy': replace(
    'src/index.mjs',
    "if(!digital&&request.service==='rush')shipping+=config.rushFee;",
    '',
  ),
  'long/holdout/dependency-scheduler': replace(
    'src/scheduler.mjs',
    'active>=concurrency',
    'active>=concurrency+1',
  ),
  'long/holdout/config-context': replace(
    'src/resolver.mjs',
    'return interpolate(load(name));',
    'return load(name);',
  ),
  'long/holdout/recoverable-migration': `require('node:fs').writeFileSync('records/.backup/03.json','{"version":1,"id":"overwritten","price":"0.00","tags":[]}');say('Done');`,
};

function faultyReference(task: EvalTask): readonly string[] {
  const scripts = [...task.reference];
  const last = required(scripts.pop());
  const observing = last.replace(
    /say\([^)]*\);(?=\s*\}\);$)/,
    'deposit("Check a faulty variant");',
  );
  if (last === observing) throw new Error(`Could not append mutation: ${task.id}`);
  return [...scripts, observing, unit(required(MUTATIONS[task.id]))];
}

describe('long task grader negative controls', () => {
  it('rejects one substantive faulty solution per task after otherwise completing its reference', async () => {
    const report = await runEvaluation({
      config: evalConfig(path.join(directory, 'mutations'), {
        concurrency: 3,
        budget: { timeoutMs: 60_000, maxCalls: 80, maxSteps: 32, maxTokens: 8192 },
      }),
      tasks: TASKS,
      root: EVAL_ROOT,
      createLlm: (task) => new SequenceLlm(faultyReference(task)),
    });
    expect(report.results).toHaveLength(8);
    expect(
      report.results.filter((result) => result.status !== 'completed' || result.passed),
    ).toEqual([]);
    expect(
      report.results.every((result) =>
        result.checks.some((check) => !check.passed && !check.id.startsWith('preserve:')),
      ),
    ).toBe(true);
  }, 120_000);

  it('does not accept an imported program that exits before the hidden assertions finish', async () => {
    const task: EvalTask = {
      ...OUTPUT_TASK,
      fixtures: { 'exit.mjs': 'process.exit(0);' },
      checks: [
        functional(
          'assertions-must-finish',
          `await import('./exit.mjs');assert.fail('Must not be bypassed');`,
        ),
      ],
    };
    const report = await runEvaluation({
      config: evalConfig(path.join(directory, 'exit')),
      tasks: [task],
      root: EVAL_ROOT,
      createLlm: () => new SequenceLlm([program('say("Done");')]),
    });
    expect(report.results[0]?.passed).toBe(false);
    expect(report.results[0]?.checks[0]?.detail).toContain('Assertions were bypassed');
  }, 20_000);
});
