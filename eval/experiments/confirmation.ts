import { tokensPerSuccess } from '../report.js';
import type { EvalReport, TrialResult } from '../types.js';
import { screenReport } from './analyze.js';

export interface Confirmation {
  readonly readyForFullRegression: boolean;
  readonly reasons: readonly string[];
  readonly tokenRatio: number | null;
  readonly medianPairRatio: number | null;
  readonly cheaperPairs: number;
  readonly pairRatios: readonly number[];
}

/** Stop once the predeclared 10/10 and 9/10 requirements are unreachable. */
export function confirmationStopReason(
  control: readonly TrialResult[],
  candidate: readonly TrialResult[],
): string | undefined {
  if ([...control, ...candidate].some((trial) => !trial.passed))
    return 'A failed attempt makes the required 10/10 in both arms unreachable.';
  if ([...control, ...candidate].some((trial) => tokens(trial) === null))
    return 'Missing token accounting prevents ten fully accounted pairs.';
  if (pairedRatios(control, candidate).filter((ratio) => ratio >= 1).length >= 2)
    return 'Two pairs without token savings make the required 9/10 cheaper pairs unreachable.';
  return undefined;
}

/** Independent repeated attempts on the key task, before the expensive full gate. */
export function confirmationVerdict(control: EvalReport, candidate: EvalReport): Confirmation {
  const reasons = screenReport(control, candidate);
  const before = tokensPerSuccess(control.results),
    after = tokensPerSuccess(candidate.results);
  const tokenRatio = before === null || after === null ? null : after / before;
  const pairRatios = pairedRatios(control.results, candidate.results);
  const sorted = [...pairRatios].sort((a, b) => a - b);
  const medianPairRatio = median(sorted);
  const cheaperPairs = pairRatios.filter((ratio) => ratio < 1).length;
  if (control.results.length !== 10 || candidate.results.length !== 10 || pairRatios.length !== 10)
    reasons.push('Need exactly ten fully accounted pairs.');
  if (!control.results.every((r) => r.passed) || !candidate.results.every((r) => r.passed))
    reasons.push('Both arms must pass all ten key-task attempts.');
  reasons.push(...efficiencyReasons(tokenRatio, medianPairRatio, cheaperPairs));
  return {
    readyForFullRegression: reasons.length === 0,
    reasons,
    tokenRatio,
    medianPairRatio,
    cheaperPairs,
    pairRatios,
  };
}

function efficiencyReasons(ratio: number | null, median: number | null, wins: number): string[] {
  const reasons: string[] = [];
  if (ratio === null || ratio > 0.85) reasons.push('Tokens per success did not improve by 15%.');
  if (median === null || median > 0.85) reasons.push('The median pair did not improve by 15%.');
  if (wins < 9) reasons.push('Fewer than nine of ten pairs used fewer tokens.');
  return reasons;
}

function pairedRatios(
  control: readonly TrialResult[],
  candidate: readonly TrialResult[],
): number[] {
  const result: number[] = [];
  for (const before of control) {
    const after = candidate.find((r) => r.taskId === before.taskId && r.attempt === before.attempt);
    const a = tokens(before),
      b = after === undefined ? null : tokens(after);
    if (a !== null && a > 0 && b !== null) result.push(b / a);
  }
  return result;
}

function tokens(trial: TrialResult): number | null {
  const { inputTokens, outputTokens } = trial.metrics;
  return inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens;
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const a = sorted[Math.floor((sorted.length - 1) / 2)],
    b = sorted[Math.floor(sorted.length / 2)];
  return a === undefined || b === undefined ? null : (a + b) / 2;
}
