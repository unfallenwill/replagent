import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EVAL_HELP, type EvalOptions, parseEvalArgs } from './options.js';
import { compareReports, type EvalComparison, hasRequiredFailures, readReport } from './report.js';
import { runEvaluation } from './run.js';
import { TASKS, validateTasks } from './tasks.js';
import type { EvalReport, EvalTask, TrialResult } from './types.js';

const root = fileURLToPath(new URL('../', import.meta.url));

async function main(): Promise<void> {
  const options = await parseEvalArgs(process.argv.slice(2), root);
  if (options.command === 'help') {
    process.stdout.write(EVAL_HELP);
    return;
  }
  if (options.command === 'compare') {
    const baseline = await readReport(options.baseline as string);
    const current = await readReport(options.current as string);
    displayComparison(compareReports(baseline, current, options.policy));
    return;
  }
  const tasks = await loadTasks(options);
  if (options.command === 'list') {
    for (const task of tasks)
      process.stdout.write(`${task.id} [${task.suite}] ${task.description}\n`);
    return;
  }
  // Validate the baseline before spending tokens.
  const baseline = options.baseline === undefined ? undefined : await readReport(options.baseline);
  const report = await runEvaluation({
    config: options.config,
    tasks,
    root,
    onTrial: displayTrial,
    ...(baseline === undefined ? {} : { baseline, policy: options.policy }),
  });
  process.stdout.write(`Report: ${path.join(options.config.out, 'report.md')}\n`);
  if (baseline !== undefined) {
    await compareRun(baseline, report, options);
  } else if (hasRequiredFailures(report)) {
    process.exitCode = 1;
  }
}

async function loadTasks(options: EvalOptions): Promise<readonly EvalTask[]> {
  const module =
    options.tasksFile === undefined
      ? { TASKS }
      : ((await import(pathToFileURL(options.tasksFile).href)) as { TASKS: readonly EvalTask[] });
  const tasks = module.TASKS.filter(
    (task) =>
      (options.suite === 'all' || task.suite === options.suite) &&
      (options.selectors.length === 0 ||
        options.selectors.some((selector) => task.id.startsWith(selector))),
  );
  if (tasks.length === 0) throw new Error('No tasks matched the selection.');
  for (const selector of options.selectors) {
    if (!tasks.some((task) => task.id.startsWith(selector)))
      throw new Error(`Unknown task selector: ${selector}`);
  }
  validateTasks(tasks);
  return tasks;
}

function displayTrial(result: TrialResult): void {
  process.stdout.write(
    (result.passed ? 'PASS ' : 'FAIL ') +
      result.taskId +
      ' #' +
      result.attempt +
      ' ' +
      result.metrics.wallMs +
      'ms calls=' +
      result.metrics.calls +
      '\n',
  );
}

async function compareRun(
  baseline: EvalReport,
  current: EvalReport,
  options: EvalOptions,
): Promise<void> {
  const comparison = compareReports(baseline, current, options.policy);
  await writeFile(
    path.join(options.config.out, 'comparison.json'),
    JSON.stringify(comparison, null, 2),
  );
  displayComparison(comparison);
}

function displayComparison(result: EvalComparison): void {
  process.stdout.write(result.passed ? 'No regressions.\n' : 'Evaluation gate failed.\n');
  for (const issue of [...result.issues, ...result.regressions])
    process.stdout.write(`- ${issue}\n`);
  for (const added of result.addedTasks) process.stdout.write(`New task: ${added}\n`);
  process.exitCode = result.compatible ? (result.passed ? 0 : 1) : 2;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
