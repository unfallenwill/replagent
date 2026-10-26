import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { UiEvent } from '../../src/domain/ports/ui.js';
import { compatibilityIssues, readReport, STRICT_POLICY, tokensPerSuccess } from '../report.js';
import type { EvalReport, TrialResult } from '../types.js';

interface Screening {
  readonly id: string;
  readonly passed: number;
  readonly trials: number;
  readonly tokensPerSuccess: number | null;
  readonly tokenRatio: number | null;
  readonly regressions: readonly string[];
  readonly checkpoints: number;
  readonly eligibleForConfirmation: boolean;
}

/** Capability tasks also participate in development screening; none are auto-promoted. */
export function screenReport(control: EvalReport, current: EvalReport): string[] {
  const failures = compatibilityIssues(control, current, STRICT_POLICY);
  for (const before of control.tasks) {
    const after = current.tasks.find((task) => task.id === before.id);
    if (after === undefined || after.hash !== before.hash || after.trials !== before.trials) {
      failures.push(`${before.id}: incompatible task`);
      continue;
    }
    if (after.passed < before.passed) failures.push(`${before.id}: fewer successful trials`);
    for (const [id, rate] of Object.entries(before.checkPassRates)) {
      if ((after.checkPassRates[id] ?? -1) < rate)
        failures.push(`${before.id}/${id}: lower check pass rate`);
    }
  }
  return failures;
}

export async function analyzeMatrix(directory: string): Promise<readonly Screening[]> {
  const ids = ['p0h0', 'p1h0', 'p0h1', 'p1h1'];
  const reports = await Promise.all(
    ids.map((id) => readReport(path.join(directory, id, 'report.json'))),
  );
  const control = reports[0];
  if (control === undefined) throw new Error('Missing control.');
  const rows = await Promise.all(
    reports.map(async (report, index): Promise<Screening> => {
      const id = ids[index] ?? '';
      const before = tokensPerSuccess(control.results),
        after = tokensPerSuccess(report.results);
      const ratio = before === null || after === null ? null : after / before;
      const regressions = screenReport(control, report);
      return {
        id,
        passed: report.results.filter((r) => r.passed).length,
        trials: report.results.length,
        tokensPerSuccess: after,
        tokenRatio: ratio,
        regressions,
        checkpoints: await checkpointCount(path.join(directory, id), report.results),
        eligibleForConfirmation:
          id !== 'p0h0' && regressions.length === 0 && ratio !== null && ratio <= 0.85,
      };
    }),
  );
  const summary = {
    status:
      'Development screening only. Independent regression and holdout confirmation is required.',
    rows,
    nominees: rows
      .filter((row) => row.eligibleForConfirmation)
      .sort((a, b) => (a.tokenRatio ?? Infinity) - (b.tokenRatio ?? Infinity))
      .map((row) => row.id),
    limitations:
      'Small repeat counts are exploratory; provider seeds are unavailable. Shared caches and asynchronous execution limit latency attribution. Tokens include cached input, are not a currency cost, and include failed attempts.',
    tasks: reports.map((report, index) => ({
      arm: ids[index],
      tasks: report.tasks.map((task) => ({
        id: task.id,
        passed: task.passed,
        trials: task.trials,
        tokensPerSuccess: tokensPerSuccess(
          report.results.filter((trial) => trial.taskId === task.id),
        ),
      })),
    })),
  };
  await writeFile(path.join(directory, 'screening.json'), JSON.stringify(summary, null, 2));
  return rows;
}

async function checkpointCount(directory: string, trials: readonly TrialResult[]): Promise<number> {
  const counts = await Promise.all(
    trials.map(async (trial) => {
      const text = await readFile(path.join(directory, trial.artifacts, 'trace.jsonl'), 'utf8');
      return appliedCheckpoints(text);
    }),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}

/** Quoted source or model text must not be mistaken for an executed harness event. */
export function appliedCheckpoints(trace: string): number {
  let count = 0;
  for (const line of trace.split('\n').filter(Boolean)) {
    const item = JSON.parse(line) as { type: string; event?: UiEvent };
    if (
      item.type === 'ui' &&
      item.event?.type === 'status' &&
      item.event.text.startsWith('harness.checkpoint applied ')
    )
      count++;
  }
  return count;
}
