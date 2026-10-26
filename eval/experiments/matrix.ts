import { appendFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT } from '../../src/app/prompt.js';
import { candidateHash } from '../bundle.js';
import { createLlmFactory } from '../llm.js';
import { createReport, createRunIdentity, type RunIdentity, writeReport } from '../report.js';
import { validateTasks } from '../tasks.js';
import { runTrial } from '../trial.js';
import type { EvalConfig, EvalReport, EvalTask, TrialResult } from '../types.js';
import { EXAMPLE_PROMPT } from './prompts.js';

export interface Arm {
  readonly id: string;
  readonly candidate: string;
  readonly systemPrompt: string;
}

export function experimentArms(root: string): readonly Arm[] {
  const plain = path.join(root, 'eval/candidate.ts');
  const memory = path.join(root, 'eval/experiments/memory-candidate.ts');
  return [
    { id: 'p0h0', candidate: plain, systemPrompt: SYSTEM_PROMPT },
    { id: 'p1h0', candidate: plain, systemPrompt: EXAMPLE_PROMPT },
    { id: 'p0h1', candidate: memory, systemPrompt: SYSTEM_PROMPT },
    { id: 'p1h1', candidate: memory, systemPrompt: EXAMPLE_PROMPT },
  ];
}

interface MatrixOptions {
  readonly config: EvalConfig;
  readonly tasks: readonly EvalTask[];
  readonly root: string;
  readonly arms: readonly Arm[];
  readonly purpose?: string;
  readonly stopWhen?: ((runs: readonly ArmRun[]) => string | undefined) | undefined;
  readonly onTrial?: (arm: string, result: TrialResult) => void;
}

interface ArmRun {
  readonly arm: Arm;
  readonly config: EvalConfig;
  readonly identity: RunIdentity;
  readonly results: TrialResult[];
}

interface Job {
  readonly arm: string;
  readonly task: EvalTask;
  readonly attempt: number;
}

/** Rotate treatment order within task/attempt blocks; one shared concurrency limit. */
export function matrixJobs(
  tasks: readonly EvalTask[],
  trials: number,
  arms: readonly Arm[],
): Job[] {
  const jobs: Job[] = [];
  for (let attempt = 1; attempt <= trials; attempt++) {
    for (const [index, task] of tasks.entries()) {
      const offset = (attempt - 1 + index) % arms.length;
      for (let n = 0; n < arms.length; n++) {
        const arm = arms[(offset + n) % arms.length];
        if (arm !== undefined) jobs.push({ arm: arm.id, task, attempt });
      }
    }
  }
  return jobs;
}

export async function runMatrix(options: MatrixOptions): Promise<readonly EvalReport[]> {
  validateTasks(options.tasks);
  if (
    options.arms.length < 2 ||
    new Set(options.arms.map((arm) => arm.id)).size !== options.arms.length
  )
    throw new Error('A treatment study needs at least two distinct arms.');
  await mkdir(path.dirname(options.config.out), { recursive: true });
  await mkdir(options.config.out);
  const runs = await Promise.all(options.arms.map((arm) => prepareArm(options, arm)));
  const runnerHash = await candidateHash(fileURLToPath(import.meta.url));
  const jobs = matrixJobs(options.tasks, options.config.trials, options.arms);
  await writeFile(
    path.join(options.config.out, 'manifest.json'),
    JSON.stringify(
      {
        schema: 1,
        runnerHash,
        purpose: options.purpose ?? 'Development screening, not a held-out result or promotion.',
        selection:
          'No task/check pass-rate drop; then compare total input+output per success, including failures. A >=15% reduction nominates a frozen candidate for independent regression and holdout runs. Otherwise retain P0H0.',
        concurrency: options.config.concurrency,
        order: jobs.map(({ arm, task, attempt }) => ({ arm, task: task.id, attempt })),
        arms: runs.map(({ arm, identity }) => ({ id: arm.id, identity })),
      },
      null,
      2,
    ),
  );
  const startedPairs = new Set<string>();
  let stopped = false;
  const stopIfNeeded = (): void => {
    if (stopped) return;
    const reason = options.stopWhen?.(runs);
    if (reason === undefined) return;
    stopped = true;
    const skipped = jobs.filter((job) => !startedPairs.has(pairId(job)));
    jobs.splice(0, jobs.length, ...jobs.filter((job) => startedPairs.has(pairId(job))));
    writeFileSync(
      path.join(options.config.out, 'stopped.json'),
      JSON.stringify(
        {
          reason,
          skipped: skipped.map(({ arm, task, attempt }) => ({ arm, task: task.id, attempt })),
        },
        null,
        2,
      ),
    );
  };
  const consume = async (): Promise<void> => {
    for (;;) {
      const job = jobs.shift();
      if (job === undefined) return;
      startedPairs.add(pairId(job));
      const run = runs.find((item) => item.arm.id === job.arm);
      if (run === undefined) throw new Error('Missing arm.');
      const result = await runTrial({
        ...job,
        config: run.config,
        llm: createLlmFactory(run.config)(job.task),
      });
      run.results.push(result);
      appendFileSync(path.join(run.config.out, 'results.jsonl'), `${JSON.stringify(result)}\n`);
      options.onTrial?.(job.arm, result);
      stopIfNeeded();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.config.concurrency, jobs.length) }, consume),
  );
  if (runnerHash !== (await candidateHash(fileURLToPath(import.meta.url))))
    throw new Error('Experiment runner changed during execution.');
  return Promise.all(runs.map((run) => finishArm(options, run)));
}

function pairId(job: Job): string {
  return `${job.task.id}/${job.attempt}`;
}

async function prepareArm(options: MatrixOptions, arm: Arm): Promise<ArmRun> {
  const config = { ...options.config, ...arm, out: path.join(options.config.out, arm.id) };
  const identity = await createRunIdentity(config, options.root);
  await mkdir(config.out);
  writeFileSync(path.join(config.out, 'identity.json'), JSON.stringify(identity, null, 2));
  writeFileSync(path.join(config.out, 'prompt.txt'), arm.systemPrompt);
  return { arm, config, identity, results: [] };
}

async function finishArm(options: MatrixOptions, run: ArmRun): Promise<EvalReport> {
  const identity = await createRunIdentity(run.config, options.root);
  for (const key of [
    'sourceHash',
    'promptHash',
    'graderHash',
    'checkpointHash',
    'evaluatorHash',
  ] as const) {
    if (identity[key] !== run.identity[key])
      throw new Error(`Source changed during experiment: ${key}`);
  }
  if (identity.candidate.hash !== run.identity.candidate.hash)
    throw new Error('Candidate changed during experiment.');
  // Preserve a readable implementation snapshot alongside its fingerprint.
  await writeFile(path.join(run.config.out, 'candidate.txt'), await readFile(run.config.candidate));
  run.results.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.attempt - b.attempt);
  const report = createReport(run.identity, options.tasks, run.results, run.config.trials);
  await writeReport(run.config.out, report);
  return report;
}
