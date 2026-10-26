import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { regradeSubset } from '../eval/regrade.js';
import { compareReports, readReport } from '../eval/report.js';
import { TASKS } from '../eval/repository/tasks.js';
import { runEvaluation } from '../eval/run.js';
import type { EvalTask } from '../eval/types.js';
import { EVAL_ROOT, evalConfig, program } from './eval-fixtures.js';

let directory = '';
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'replagent-regrade-test-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const ORIGINAL: EvalTask = {
  id: 'test/rubric',
  suite: 'capability',
  description: 'A legitimate documentation update was wrongly forbidden.',
  fixtures: { 'README.md': 'old docs' },
  turns: ['Write result.txt containing correct. Documentation updates are allowed.'],
  checks: [
    { id: 'result', type: 'file', path: 'result.txt', content: 'correct' },
    { id: 'unasked-guard', type: 'unchanged', path: 'README.md' },
  ],
  reference: [
    program(
      'const fs=require("node:fs");fs.writeFileSync("result.txt","correct");fs.writeFileSync("README.md","new docs");say("Done");',
    ),
  ],
};

it('regrades existing verdicts with explicit provenance and leaves the original report untouched', async () => {
  const source = path.join(directory, 'original'),
    out = path.join(directory, 'reviewed');
  const raw = await runEvaluation({
    root: EVAL_ROOT,
    config: evalConfig(source),
    tasks: [ORIGINAL],
  });
  expect(raw.results[0]?.passed).toBe(false);
  const task = { ...ORIGINAL, checks: ORIGINAL.checks.filter((check) => check.id === 'result') };
  const reviewed = await regradeSubset({
    fromReport: path.join(source, 'report.json'),
    originals: [ORIGINAL],
    tasks: [task],
    out,
    reason: 'The user explicitly allows documentation changes.',
  });
  expect(reviewed.results[0]?.passed).toBe(true);
  expect(reviewed.results[0]?.metrics).toEqual(raw.results[0]?.metrics);
  expect((await readReport(path.join(source, 'report.json'))).results[0]?.passed).toBe(false);
  expect((await readReport(path.join(out, 'report.json'))).results[0]?.passed).toBe(true);
  expect(compareReports(raw, reviewed).compatible).toBe(false);
  const lineage = JSON.parse(await readFile(path.join(out, 'regrade.json'), 'utf8')) as {
    newModelCalls: number;
    removedChecks: Record<string, string[]>;
  };
  expect(lineage.newModelCalls).toBe(0);
  expect(lineage.removedChecks[ORIGINAL.id]).toEqual(['unasked-guard']);
}, 20_000);

it('refuses to reuse verdicts after changing task instructions or rewriting assertions', async () => {
  const source = path.join(directory, 'original');
  await runEvaluation({ root: EVAL_ROOT, config: evalConfig(source), tasks: [ORIGINAL] });
  const options = {
    fromReport: path.join(source, 'report.json'),
    originals: [ORIGINAL],
    out: path.join(directory, 'invalid'),
    reason: 'review',
  };
  await expect(
    regradeSubset({ ...options, tasks: [{ ...ORIGINAL, turns: ['A different task.'] }] }),
  ).rejects.toThrow('Cannot change prompts');
  await expect(
    regradeSubset({
      ...options,
      tasks: [
        {
          ...ORIGINAL,
          checks: [{ id: 'result', type: 'file', path: 'result.txt', content: 'different' }],
        },
      ],
    }),
  ).rejects.toThrow('Cannot add or rewrite checks');
}, 20_000);

it('permits documentation while protecting the root configuration and original test suite', () => {
  for (const task of TASKS) {
    expect(task.checks.some((check) => check.id === 'preserve:README.md')).toBe(false);
    expect(task.checks.some((check) => check.id === 'preserve:package.json')).toBe(true);
    expect(task.checks.some((check) => check.id === 'preserve:tsconfig.json')).toBe(true);
    expect(task.checks.some((check) => check.id === 'preserve:test/toolkit.test.ts')).toBe(true);
  }
});
