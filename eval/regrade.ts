import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash, taskHash } from './files.js';
import { createReport, readReport, renderReport, writeReport } from './report.js';
import { validateTasks } from './tasks.js';
import type { EvalReport, EvalTask, TrialResult } from './types.js';

interface RegradeOptions {
  readonly fromReport: string;
  readonly originals: readonly EvalTask[];
  readonly tasks: readonly EvalTask[];
  readonly out: string;
  readonly reason: string;
}

/** Correct an over-restrictive rubric without inventing new observations or model calls. */
export async function regradeSubset(options: RegradeOptions): Promise<EvalReport> {
  if (options.reason.trim().length === 0)
    throw new Error('A rubric correction needs an explicit reason.');
  validateTasks(options.tasks);
  const original = await readReport(options.fromReport);
  const removed = validateCorrection(original, options.originals, options.tasks);
  const results = original.results.map((trial) =>
    regradeTrial(trial, options.tasks, path.dirname(options.fromReport), options.out),
  );
  const { tasks: _tasks, results: _results, ...identity } = original;
  const report = createReport(identity, options.tasks, results, 1);
  await mkdir(path.dirname(options.out), { recursive: true });
  await mkdir(options.out);
  await writeReport(options.out, report);
  await writeFile(
    path.join(options.out, 'report.md'),
    `# Corrected rubric: existing observations, no new model trials\n\n${options.reason}\n\n${renderReport(report)}`,
  );
  await writeFile(
    path.join(options.out, 'regrade.json'),
    JSON.stringify(
      {
        fromReport: path.relative(options.out, options.fromReport),
        sourceReportHash: hash(await readFile(options.fromReport, 'utf8')),
        reason: options.reason,
        removedChecks: removed,
        newModelCalls: 0,
        tasks: report.tasks.map((task) => ({
          id: task.id,
          originalHash: original.tasks.find((old) => old.id === task.id)?.hash,
          correctedHash: task.hash,
        })),
      },
      null,
      2,
    ),
  );
  return report;
}

function validateCorrection(
  report: EvalReport,
  originals: readonly EvalTask[],
  tasks: readonly EvalTask[],
): Record<string, string[]> {
  if (tasks.length !== report.tasks.length)
    throw new Error('Cannot add or remove tasks when regrading recorded checks.');
  const removed: Record<string, string[]> = {};
  for (const task of tasks) {
    const before = originals.find((old) => old.id === task.id);
    const summary = report.tasks.find((old) => old.id === task.id);
    if (before === undefined || summary?.hash !== taskHash(before))
      throw new Error('Original rubric does not match the recorded fingerprint.');
    const { checks: oldChecks, reference: _oldReference, ...oldDefinition } = before;
    const { checks, reference: _reference, ...definition } = task;
    if (!isDeepStrictEqual(oldDefinition, definition))
      throw new Error(
        'Cannot change prompts, fixtures, or task conditions during subset regrading.',
      );
    for (const check of checks) {
      if (!oldChecks.some((old) => isDeepStrictEqual(old, check)))
        throw new Error('Cannot add or rewrite checks without executing graders again.');
    }
    removed[task.id] = oldChecks
      .filter((check) => !checks.some((kept) => kept.id === check.id))
      .map((check) => check.id);
  }
  return removed;
}

function regradeTrial(
  trial: TrialResult,
  tasks: readonly EvalTask[],
  source: string,
  out: string,
): TrialResult {
  const task = tasks.find((item) => item.id === trial.taskId);
  if (task === undefined) throw new Error('Recorded trial has no corrected task.');
  const checks = trial.checks.filter((check) => task.checks.some((kept) => kept.id === check.id));
  if (checks.length !== task.checks.length)
    throw new Error('A retained check has no recorded verdict.');
  return {
    ...trial,
    checks,
    passed: trial.status === 'completed' && checks.every((check) => check.passed),
    artifacts: path.relative(out, path.resolve(source, trial.artifacts)).split(path.sep).join('/'),
  };
}
