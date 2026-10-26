import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runEvaluation } from '../eval/run.js';
import { TASKS } from '../eval/tasks.js';
import type { EvalConfig, EvalReport, EvalTask } from '../eval/types.js';
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
  directory = await mkdtemp(path.join(tmpdir(), 'replagent-eval-integration-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function run(
  replies: readonly string[],
  task: EvalTask = OUTPUT_TASK,
  overrides: Partial<EvalConfig> = {},
): Promise<EvalReport> {
  return runEvaluation({
    config: evalConfig(path.join(directory, 'run'), overrides),
    tasks: [task],
    root: EVAL_ROOT,
    createLlm: () => new SequenceLlm(replies),
  });
}

describe('real agent evaluation execution', () => {
  it('verifies every starter task has a working reference using the real agent and REPL', async () => {
    const report = await runEvaluation({
      config: evalConfig(path.join(directory, 'reference'), { concurrency: 4 }),
      tasks: TASKS,
      root: EVAL_ROOT,
    });
    expect(report.results).toHaveLength(20);
    expect(report.results.filter((result) => !result.passed)).toEqual([]);
    expect(report.results.every((result) => result.metrics.inputTokens === null)).toBe(true);
  }, 90_000);

  it('rejects a claim of completion when the artifact is wrong', async () => {
    const report = await run([program('say("Done, all tests passed");')]);
    expect(report.results[0]).toMatchObject({ status: 'completed', passed: false });
    expect(report.results[0]?.checks.find((check) => check.id === 'result')?.passed).toBe(false);
    const trace = await readFile(
      path.join(directory, 'run', required(report.results[0]).artifacts, 'trace.jsonl'),
      'utf8',
    );
    expect(trace).toContain('all tests passed');
  }, 20_000);

  it('isolates process globals and files across repeated trials', async () => {
    const code = program(
      'const fs=require("node:fs"); if(globalThis.leak || fs.existsSync("leak.txt")) throw new Error("state leaked"); globalThis.leak=true; fs.writeFileSync("leak.txt","x"); fs.writeFileSync("result.txt","correct"); say("Done");',
    );
    const report = await run([code], OUTPUT_TASK, { trials: 2 });
    expect(report.results.map((result) => result.passed)).toEqual([true, true]);
  }, 25_000);

  it('retains persistent REPL state between user turns inside a trial', async () => {
    const task = required(TASKS.find((candidate) => candidate.id === 'state/across-user-turns'));
    const report = await run(task.reference, task);
    expect(report.results[0]).toMatchObject({ passed: true, metrics: { calls: 2 } });
  }, 20_000);

  it('keeps controller credentials and preload options out of the agent process', async () => {
    const report = await run([
      program(
        'const env=require("node:process").env; for(const key of ["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","NODE_OPTIONS"]) if(env[key]) throw new Error("credential leaked"); require("node:fs").writeFileSync("result.txt","correct"); say("Done");',
      ),
    ]);
    expect(report.results[0]?.passed).toBe(true);
  }, 20_000);

  it('enforces model-call budgets outside the candidate loop', async () => {
    const report = await run(
      [program('deposit("continue");'), program('deposit("continue");')],
      OUTPUT_TASK,
      { budget: { timeoutMs: 20_000, maxCalls: 2, maxSteps: 12, maxTokens: 1000 } },
    );
    expect(report.results[0]).toMatchObject({
      status: 'budget',
      passed: false,
      metrics: { calls: 2 },
    });
  }, 20_000);

  it('terminates synchronous infinite JavaScript from outside the worker', async () => {
    const report = await run([program('while(true) {}')], OUTPUT_TASK, {
      budget: { timeoutMs: 6000, maxCalls: 4, maxSteps: 4, maxTokens: 1000 },
    });
    expect(report.results[0]).toMatchObject({
      status: 'timeout',
      passed: false,
      metrics: { calls: 1 },
    });
  }, 20_000);

  it('allows replacing the harness and prompt together without changing graders', async () => {
    const candidate = path.join(directory, 'candidate.mjs');
    const implementation = pathToFileURL(path.join(EVAL_ROOT, 'eval/candidate.ts')).href;
    await writeFile(
      candidate,
      `import {createSubject as original} from ${JSON.stringify(implementation)}; export const createSubject = (ctx) => original({...ctx,systemPrompt:ctx.systemPrompt+" custom"});`,
    );
    const report = await run(OUTPUT_TASK.reference, OUTPUT_TASK, {
      candidate,
      systemPrompt: 'short protocol',
    });
    expect(report.results[0]?.passed).toBe(true);
    const trace = await readFile(
      path.join(directory, 'run', required(report.results[0]).artifacts, 'trace.jsonl'),
      'utf8',
    );
    expect(trace).toContain('short protocol custom');
  }, 20_000);

  it('refuses to overwrite an existing run or baseline', async () => {
    const config = evalConfig(path.join(directory, 'run'));
    await run(OUTPUT_TASK.reference);
    await expect(runEvaluation({ config, tasks: [OUTPUT_TASK], root: EVAL_ROOT })).rejects.toThrow(
      /EEXIST/,
    );
  }, 20_000);

  it('rejects incompatible comparisons before requesting model tokens', async () => {
    const config = evalConfig(path.join(directory, 'before'));
    const baseline = await runEvaluation({ config, tasks: [OUTPUT_TASK], root: EVAL_ROOT });
    let requested = false;
    await expect(
      runEvaluation({
        config: {
          ...config,
          out: path.join(directory, 'after'),
          budget: { ...config.budget, maxCalls: 99 },
        },
        tasks: [OUTPUT_TASK],
        root: EVAL_ROOT,
        baseline,
        createLlm: () => {
          requested = true;
          return new SequenceLlm(OUTPUT_TASK.reference);
        },
      }),
    ).rejects.toThrow(/Incompatible evaluation/);
    expect(requested).toBe(false);
  }, 20_000);
});
