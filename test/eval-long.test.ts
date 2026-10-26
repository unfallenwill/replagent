import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TASKS } from '../eval/long/tasks.js';
import { runEvaluation } from '../eval/run.js';
import { validateTasks } from '../eval/tasks.js';
import type { EvalTask } from '../eval/types.js';
import { EVAL_ROOT, evalConfig, program, required, SequenceLlm } from './eval-fixtures.js';

let directory = '';
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'replagent-long-test-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const budget = { timeoutMs: 60_000, maxCalls: 80, maxSteps: 32, maxTokens: 8192 };

describe('long task evaluation', () => {
  it('runs all eight references through the production agent, per-turn checkpoints, and external updates', async () => {
    validateTasks(TASKS);
    expect(TASKS.filter((task) => task.partition === 'development')).toHaveLength(5);
    expect(TASKS.filter((task) => task.partition === 'holdout')).toHaveLength(3);
    const report = await runEvaluation({
      config: evalConfig(path.join(directory, 'reference'), { budget, concurrency: 3 }),
      tasks: TASKS,
      root: EVAL_ROOT,
    });
    expect(report.results.filter((result) => !result.passed)).toEqual([]);
    expect(report.results).toHaveLength(8);
  }, 120_000);

  it('rejects completion claims for every task even when every user turn receives an answer', async () => {
    const report = await runEvaluation({
      config: evalConfig(path.join(directory, 'noop'), { budget, concurrency: 3 }),
      tasks: TASKS,
      root: EVAL_ROOT,
      createLlm: (task) =>
        new SequenceLlm(task.turns.map(() => program('say("Completed successfully");'))),
    });
    expect(report.results.every((result) => result.status === 'completed' && !result.passed)).toBe(
      true,
    );
  }, 120_000);

  it('records an earlier failure even if the final workspace is corrected', async () => {
    const task: EvalTask = {
      id: 'test/checkpoints',
      suite: 'regression',
      description: 'Retain the actual state at each accepted user turn.',
      fixtures: { 'value.txt': 'wrong' },
      turns: ['Write first.', 'Write final.'],
      checks: [
        { id: 'first', type: 'file', path: 'value.txt', content: 'first', afterTurn: 0 },
        { id: 'final', type: 'file', path: 'value.txt', content: 'final' },
        { id: 'retained-bytes', type: 'unchanged', path: 'value.txt', sinceTurn: 0 },
      ],
      reference: [
        program('say("Done");'),
        program('require("node:fs").writeFileSync("value.txt","final");say("Done");'),
      ],
    };
    const report = await runEvaluation({
      config: evalConfig(path.join(directory, 'checkpoints'), { budget }),
      tasks: [task],
      root: EVAL_ROOT,
    });
    expect(required(report.results[0]).checks.map((check) => check.passed)).toEqual([
      false,
      true,
      false,
    ]);
    const checkpoint = JSON.parse(
      await readFile(
        path.join(
          directory,
          'checkpoints',
          required(report.results[0]).artifacts,
          'checkpoints/0.json',
        ),
        'utf8',
      ),
    ) as Record<string, { content: string }>;
    expect(checkpoint['value.txt']?.content).toBe('wrong');
  }, 20_000);

  it('applies external input updates between turns without restarting the REPL', async () => {
    const task: EvalTask = {
      id: 'test/updates',
      suite: 'regression',
      description: 'Read fresh disk input while keeping model-owned REPL state.',
      fixtures: { 'input.txt': 'old' },
      turns: ['Remember old.', 'Read new.'],
      updates: [{ beforeTurn: 1, files: { 'input.txt': 'new' } }],
      checks: [{ id: 'value', type: 'file', path: 'result.txt', content: 'old/new' }],
      reference: [
        program(
          'globalThis.old=require("node:fs").readFileSync("input.txt","utf8");say("Remembered");',
        ),
        program(
          'const fs=require("node:fs");fs.writeFileSync("result.txt",globalThis.old+"/"+fs.readFileSync("input.txt","utf8"));say("Done");',
        ),
      ],
    };
    const report = await runEvaluation({
      config: evalConfig(path.join(directory, 'updates'), { budget }),
      tasks: [task],
      root: EVAL_ROOT,
    });
    expect(report.results[0]?.passed).toBe(true);
  }, 20_000);

  it('rejects invalid checkpoint indices and unsafe external update paths', () => {
    const task = required(TASKS[0]);
    expect(() =>
      validateTasks([
        { ...task, checks: [{ id: 'bad', type: 'answer', includes: 'ok', afterTurn: 99 }] },
      ]),
    ).toThrow('Invalid user turn');
    expect(() =>
      validateTasks([{ ...task, updates: [{ beforeTurn: 0, files: { '../escape.txt': 'x' } }] }]),
    ).toThrow('workspace-relative');
  });
});
