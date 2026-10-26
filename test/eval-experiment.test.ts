import { expect, it } from 'vitest';
import { appliedCheckpoints, screenReport } from '../eval/experiments/analyze.js';
import { fixtureReport, trialResult } from './eval-fixtures.js';

it('counts applied harness events without counting quoted source or model output', () => {
  const trace = [
    { type: 'llm.text', text: 'harness.checkpoint applied ' },
    { type: 'ui', event: { type: 'agent-code', text: 'harness.checkpoint applied ' } },
    { type: 'ui', event: { type: 'status', text: 'harness.checkpoint applied {"count":1}' } },
  ]
    .map((item) => JSON.stringify(item))
    .join('\n');
  expect(appliedCheckpoints(trace)).toBe(1);
});

it('screens capability failures even when the normal regression gate would leave them exploratory', () => {
  const before = fixtureReport([trialResult(true, 1), trialResult(true, 2)]);
  const after = fixtureReport([trialResult(true, 1), trialResult(false, 2)]);
  const control = {
    ...before,
    tasks: before.tasks.map((task) => ({ ...task, suite: 'capability' as const })),
  };
  const candidate = {
    ...after,
    tasks: after.tasks.map((task) => ({ ...task, suite: 'capability' as const })),
  };
  expect(screenReport(control, candidate)).toEqual([
    'test/output: fewer successful trials',
    'test/output/result: lower check pass rate',
  ]);
});

it('refuses development screening across changed evaluator implementations', () => {
  const report = fixtureReport([trialResult(true)]);
  expect(
    screenReport({ ...report, evaluatorHash: 'old' }, { ...report, evaluatorHash: 'new' }),
  ).toContain('Evaluator implementation changed; review and establish a new baseline.');
});
