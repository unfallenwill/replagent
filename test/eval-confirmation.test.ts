import { expect, it } from 'vitest';
import { confirmationStopReason, confirmationVerdict } from '../eval/experiments/confirmation.js';
import type { EvalReport } from '../eval/types.js';
import { fixtureReport, trialResult } from './eval-fixtures.js';

function report(ratios: readonly number[]): EvalReport {
  return fixtureReport(
    ratios.map((ratio, index) => {
      const trial = trialResult(true, index + 1);
      return {
        ...trial,
        metrics: { ...trial.metrics, inputTokens: ratio * 100, outputTokens: ratio * 20 },
      };
    }),
  );
}

it('requires repeatable improvements rather than one unusually expensive control trial', () => {
  const control = report(Array<number>(10).fill(1));
  const candidate = report([...Array<number>(8).fill(0.5), 2, 2]);
  const result = confirmationVerdict(control, candidate);
  expect(result.tokenRatio).toBe(0.8);
  expect(result.medianPairRatio).toBe(0.5);
  expect(result.readyForFullRegression).toBe(false);
  expect(result.reasons).toContain('Fewer than nine of ten pairs used fewer tokens.');
});

it('only advances a complete ten-pair result and never treats missing accounting as savings', () => {
  const control = report(Array<number>(10).fill(1));
  const candidate = report([...Array<number>(9).fill(0.6), 2]);
  expect(confirmationVerdict(control, candidate).readyForFullRegression).toBe(true);
  const unknown = {
    ...candidate,
    results: candidate.results.map((trial, index) =>
      index === 0 ? { ...trial, metrics: { ...trial.metrics, outputTokens: null } } : trial,
    ),
  };
  expect(confirmationVerdict(control, unknown).readyForFullRegression).toBe(false);
  expect(
    confirmationVerdict(report([1, 1, 1]), report([0.5, 0.5, 0.5])).readyForFullRegression,
  ).toBe(false);
});

it('only stops for a predeclared requirement that remaining pairs cannot repair', () => {
  const control = report([1, 1, 1]);
  expect(confirmationStopReason(control.results, report([0.5, 1.1]).results)).toBeUndefined();
  expect(confirmationStopReason(control.results, report([0.5, 1.1, 1.2]).results)).toContain(
    '9/10',
  );
  expect(confirmationStopReason(control.results, [trialResult(false)])).toContain('10/10');
});
