import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash, sourceHash, taskHash } from './files.js';
import type { EvalConfig, EvalReport, EvalTask, TaskSummary, TrialResult } from './types.js';

export type RunIdentity = Omit<EvalReport, 'tasks' | 'results'>;

export async function createRunIdentity(config: EvalConfig, root: string): Promise<RunIdentity> {
  return {
    schema: 1,
    at: new Date().toISOString(),
    mode: config.mode,
    model: config.mode === 'reference' ? 'reference-programs' : config.model,
    endpoint: config.mode === 'reference' ? 'offline' : publicEndpoint(config.endpoint),
    effort: config.effort,
    concurrency: config.concurrency,
    budget: config.budget,
    candidate: {
      path: path.relative(root, config.candidate),
      hash: hash(await readFile(config.candidate, 'utf8')),
    },
    promptHash: hash(config.systemPrompt),
    sourceHash: await sourceHash(root),
    graderHash: hash(await readFile(new URL('./graders.ts', import.meta.url), 'utf8')),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
  };
}

export function createReport(
  identity: RunIdentity,
  tasks: readonly EvalTask[],
  results: readonly TrialResult[],
  trials: number,
): EvalReport {
  return { ...identity, tasks: tasks.map((task) => summarizeTask(task, results, trials)), results };
}

function publicEndpoint(value: string): string {
  const url = new URL(value);
  return url.origin + url.pathname;
}

function summarizeTask(
  task: EvalTask,
  results: readonly TrialResult[],
  plannedTrials: number,
): TaskSummary {
  const trials = results.filter((result) => result.taskId === task.id);
  const count = trials.length || plannedTrials;
  return {
    id: task.id,
    suite: task.suite,
    hash: taskHash(task),
    trials: count,
    passed: trials.filter((result) => result.passed).length,
    checkPassRates: Object.fromEntries(
      task.checks.map((check) => [
        check.id,
        trials.filter((trial) =>
          trial.checks.some((result) => result.id === check.id && result.passed),
        ).length / count,
      ]),
    ),
  };
}

export async function writeReport(out: string, report: EvalReport): Promise<void> {
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(out, 'report.md'), renderReport(report));
}

export function renderReport(report: EvalReport): string {
  const count = report.results.filter((result) => result.passed).length;
  const tasks = report.tasks.length;
  const passOne = report.tasks.reduce((sum, task) => sum + task.passed / task.trials, 0) / tasks;
  const passAny = report.tasks.filter((task) => task.passed > 0).length / tasks;
  const passAll = report.tasks.filter((task) => task.passed === task.trials).length / tasks;
  const label =
    report.mode === 'reference'
      ? 'Reference self-check (NOT model capability)'
      : 'Live agent evaluation';
  const lines = [
    `# ${label}`,
    '',
    `${report.at} | ${report.model} | ${report.runtime.node} ${report.runtime.platform}`,
    '',
    `Passed trials: ${count}/${report.results.length}`,
    '',
    'pass@1: ' +
      percent(passOne) +
      ' | at least one trial passed: ' +
      percent(passAny) +
      ' | all trials passed: ' +
      percent(passAll),
    '',
    '| Task | Suite | Passed | Calls/trial | ms/trial | Tokens/success |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  ];
  for (const task of report.tasks) {
    const trials = report.results.filter((result) => result.taskId === task.id);
    lines.push(
      '| ' +
        task.id +
        ' | ' +
        task.suite +
        ' | ' +
        task.passed +
        '/' +
        task.trials +
        ' | ' +
        mean(trials.map((trial) => trial.metrics.calls)).toFixed(1) +
        ' | ' +
        Math.round(mean(trials.map((trial) => trial.metrics.wallMs))) +
        ' | ' +
        display(tokensPerSuccess(trials)) +
        ' |',
    );
  }
  for (const trial of report.results.filter((result) => !result.passed)) {
    lines.push('', `## ${trial.taskId} #${trial.attempt}`, '', `Status: ${trial.status}`);
    if (trial.error !== undefined) lines.push('', trial.error);
    for (const check of trial.checks.filter((check) => !check.passed)) {
      lines.push('', `- ${check.id}: ${check.detail.replaceAll('\n', ' ').slice(0, 1000)}`);
    }
    lines.push('', `Artifacts: ${trial.artifacts}`);
  }
  return `${lines.join('\n')}\n`;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function tokensPerSuccess(trials: readonly TrialResult[]): number | null {
  const successful = trials.filter((trial) => trial.passed).length;
  if (
    successful === 0 ||
    trials.some(
      (trial) => trial.metrics.inputTokens === null || trial.metrics.outputTokens === null,
    )
  ) {
    return null;
  }
  return (
    trials.reduce(
      (sum, trial) => sum + (trial.metrics.inputTokens ?? 0) + (trial.metrics.outputTokens ?? 0),
      0,
    ) / successful
  );
}

export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function display(value: number | null): string {
  return value === null ? 'unknown' : String(Math.round(value));
}

export interface ComparePolicy {
  readonly maxPassRateDrop: number;
  readonly maxTokenRatio?: number;
  readonly maxLatencyRatio?: number;
  readonly allowModelChange: boolean;
}

export interface EvalComparison {
  readonly compatible: boolean;
  readonly passed: boolean;
  readonly issues: readonly string[];
  readonly regressions: readonly string[];
  readonly addedTasks: readonly string[];
}

export const STRICT_POLICY: ComparePolicy = { maxPassRateDrop: 0, allowModelChange: false };

/** Added tasks are welcome; silently removing or rewriting old tasks is not. */
export function compareReports(
  baseline: EvalReport,
  current: EvalReport,
  policy: ComparePolicy = STRICT_POLICY,
): EvalComparison {
  const issues = compatibilityIssues(baseline, current, policy);
  const regressions: string[] = [];
  for (const old of baseline.tasks) {
    const next = current.tasks.find((task) => task.id === old.id);
    if (next === undefined || next.hash !== old.hash) continue;
    if (old.suite !== 'regression' && current.mode !== 'reference') continue;
    compareTask(old, next, policy, regressions);
    compareEfficiency(old.id, baseline, current, policy, regressions);
  }
  compareNewTasks(baseline, current, regressions);
  return {
    compatible: issues.length === 0,
    passed: issues.length === 0 && regressions.length === 0,
    issues,
    regressions,
    addedTasks: current.tasks
      .filter((task) => !baseline.tasks.some((old) => old.id === task.id))
      .map((task) => task.id),
  };
}

function compareNewTasks(baseline: EvalReport, current: EvalReport, regressions: string[]): void {
  for (const task of current.tasks.filter(
    (task) => !baseline.tasks.some((old) => old.id === task.id),
  )) {
    if (
      (task.suite === 'regression' || current.mode === 'reference') &&
      task.passed < task.trials
    ) {
      regressions.push(`New required task failed: ${task.id}`);
    }
  }
}

export function hasRequiredFailures(report: EvalReport): boolean {
  return report.results.some(
    (trial) =>
      !trial.passed &&
      (report.mode === 'reference' ||
        report.tasks.some((task) => task.id === trial.taskId && task.suite === 'regression')),
  );
}

export function compatibilityIssues(
  baseline: EvalReport,
  current: EvalReport,
  policy: ComparePolicy,
): string[] {
  const issues: string[] = [];
  if (policy.maxLatencyRatio !== undefined && baseline.concurrency !== current.concurrency)
    issues.push('Concurrency changed; latency gates require matching concurrency.');
  if (baseline.graderHash !== current.graderHash)
    issues.push('Grader implementation changed; review and establish a new baseline.');
  if (baseline.mode !== current.mode) issues.push('Reference and live results cannot be compared.');
  if (!isDeepStrictEqual(baseline.budget, current.budget)) issues.push('Trial budgets changed.');
  if (!policy.allowModelChange && !sameModel(baseline, current))
    issues.push('Model, endpoint, or effort changed; use --allow-model-change explicitly.');
  issues.push(...taskCompatibilityIssues(baseline.tasks, current.tasks));
  return issues;
}

function taskCompatibilityIssues(
  baseline: readonly TaskSummary[],
  current: readonly TaskSummary[],
): string[] {
  const issues: string[] = [];
  for (const old of baseline) {
    const next = current.find((task) => task.id === old.id);
    if (next === undefined) issues.push(`Baseline task is missing: ${old.id}`);
    else if (next.hash !== old.hash) issues.push(`Baseline task definition changed: ${old.id}`);
    else if (next.trials !== old.trials) issues.push(`Trial count changed: ${old.id}`);
  }
  return issues;
}

function sameModel(a: EvalReport, b: EvalReport): boolean {
  return a.model === b.model && a.endpoint === b.endpoint && a.effort === b.effort;
}

function compareTask(
  old: TaskSummary,
  next: TaskSummary,
  policy: ComparePolicy,
  failures: string[],
): void {
  const drop = old.passed / old.trials - next.passed / next.trials;
  if (drop > policy.maxPassRateDrop + Number.EPSILON) {
    failures.push(
      old.id +
        ': success rate ' +
        percent(old.passed / old.trials) +
        ' -> ' +
        percent(next.passed / next.trials),
    );
  }
  for (const [check, rate] of Object.entries(old.checkPassRates)) {
    const after = next.checkPassRates[check] ?? 0;
    if (rate - after > policy.maxPassRateDrop + Number.EPSILON) {
      failures.push(`${old.id}/${check}: ${percent(rate)} -> ${percent(after)}`);
    }
  }
}

function compareEfficiency(
  id: string,
  baseline: EvalReport,
  current: EvalReport,
  policy: ComparePolicy,
  failures: string[],
): void {
  const before = baseline.results.filter((trial) => trial.taskId === id);
  const after = current.results.filter((trial) => trial.taskId === id);
  checkRatio(
    id,
    'tokens/success',
    tokensPerSuccess(before),
    tokensPerSuccess(after),
    policy.maxTokenRatio,
    failures,
  );
  checkRatio(
    id,
    'ms/trial',
    mean(before.map((trial) => trial.metrics.wallMs)),
    mean(after.map((trial) => trial.metrics.wallMs)),
    policy.maxLatencyRatio,
    failures,
  );
}

function checkRatio(
  id: string,
  metric: string,
  before: number | null,
  after: number | null,
  limit: number | undefined,
  failures: string[],
): void {
  if (limit === undefined) return;
  if (before === null || after === null) {
    failures.push(`${id}: cannot verify ${metric} (unknown accounting or no successes).`);
  } else if (after > before * limit) {
    failures.push(`${id}: ${metric} ${Math.round(before)} -> ${Math.round(after)}`);
  }
}

export async function readReport(file: string): Promise<EvalReport> {
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!validReport(raw)) throw new Error(`Invalid evaluation report: ${file}`);
  return raw;
}

function validReport(value: unknown): value is EvalReport {
  if (!record(value)) return false;
  return (
    value['schema'] === 1 &&
    validIdentity(value) &&
    validBudget(value['budget']) &&
    nonemptyArray(value['tasks'], validTaskSummary) &&
    nonemptyArray(value['results'], validTrial) &&
    consistentResults(value as unknown as EvalReport)
  );
}

function validTaskSummary(value: unknown): value is TaskSummary {
  if (!record(value)) return false;
  return (
    typeof value['id'] === 'string' &&
    typeof value['hash'] === 'string' &&
    ['regression', 'capability'].includes(String(value['suite'])) &&
    validCounts(value['trials'], value['passed']) &&
    validRates(value['checkPassRates'])
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonemptyArray(value: unknown, check: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(check);
}

function validIdentity(raw: Record<string, unknown>): boolean {
  return (
    ['live', 'reference'].includes(String(raw['mode'])) &&
    ['model', 'endpoint', 'effort', 'at', 'promptHash', 'sourceHash'].every(
      (key) => typeof raw[key] === 'string',
    ) &&
    record(raw['candidate']) &&
    record(raw['runtime'])
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validBudget(value: unknown): boolean {
  return (
    record(value) &&
    ['timeoutMs', 'maxCalls', 'maxSteps', 'maxTokens'].every((key) => positiveInteger(value[key]))
  );
}

function validCounts(trials: unknown, passed: unknown): boolean {
  return (
    positiveInteger(trials) &&
    typeof passed === 'number' &&
    Number.isSafeInteger(passed) &&
    passed >= 0 &&
    passed <= trials
  );
}

function validRates(value: unknown): boolean {
  return (
    record(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every(
      (rate) => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 1,
    )
  );
}

function validTrial(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    typeof value['taskId'] === 'string' &&
    positiveInteger(value['attempt']) &&
    typeof value['passed'] === 'boolean' &&
    typeof value['artifacts'] === 'string' &&
    ['completed', 'timeout', 'budget', 'error'].includes(String(value['status'])) &&
    nonemptyArray(value['checks'], validCheck) &&
    validMetrics(value['metrics'])
  );
}

function validCheck(value: unknown): boolean {
  return (
    record(value) &&
    typeof value['id'] === 'string' &&
    typeof value['passed'] === 'boolean' &&
    typeof value['detail'] === 'string'
  );
}

function validMetrics(value: unknown): boolean {
  if (!record(value)) return false;
  const counters = ['wallMs', 'calls', 'steps', 'toolCalls', 'replErrors'];
  const tokens = ['inputTokens', 'outputTokens', 'cachedTokens'];
  return (
    counters.every((key) => nonnegative(value[key])) &&
    tokens.every((key) => value[key] === null || nonnegative(value[key]))
  );
}

function nonnegative(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function consistentResults(report: EvalReport): boolean {
  if (
    report.results.some(
      (trial) =>
        trial.passed !==
        (trial.status === 'completed' && trial.checks.every((check) => check.passed)),
    )
  )
    return false;
  if (new Set(report.tasks.map((task) => task.id)).size !== report.tasks.length) return false;
  if (report.results.some((trial) => !report.tasks.some((task) => task.id === trial.taskId)))
    return false;
  return report.tasks.every((task) => {
    const trials = report.results.filter((trial) => trial.taskId === task.id);
    return (
      trials.length === task.trials &&
      new Set(trials.map((trial) => trial.attempt)).size === task.trials &&
      trials.filter((trial) => trial.passed).length === task.passed &&
      consistentCheckRates(task, trials)
    );
  });
}

function consistentCheckRates(task: TaskSummary, trials: readonly TrialResult[]): boolean {
  const ids = Object.keys(task.checkPassRates).sort();
  if (trials.some((trial) => !isDeepStrictEqual(trial.checks.map((check) => check.id).sort(), ids)))
    return false;
  return ids.every((id) => {
    const rate =
      trials.filter((trial) => trial.checks.some((check) => check.id === id && check.passed))
        .length / trials.length;
    return rate === task.checkPassRates[id];
  });
}
