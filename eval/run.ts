import { appendFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LlmPort } from '../src/domain/ports/llm.js';
import { createLlmFactory } from './llm.js';
import {
  type ComparePolicy,
  compatibilityIssues,
  createReport,
  createRunIdentity,
  STRICT_POLICY,
  writeReport,
} from './report.js';
import { validateTasks } from './tasks.js';
import { runTrial } from './trial.js';
import type { EvalConfig, EvalReport, EvalTask, TrialResult } from './types.js';

export interface RunOptions {
  readonly config: EvalConfig;
  readonly tasks: readonly EvalTask[];
  readonly root: string;
  readonly createLlm?: (task: EvalTask) => LlmPort;
  readonly onTrial?: (result: TrialResult) => void;
  readonly baseline?: EvalReport;
  readonly policy?: ComparePolicy;
}

export async function runEvaluation(options: RunOptions): Promise<EvalReport> {
  validateTasks(options.tasks);
  await readFile(options.config.candidate);
  const identity = await createRunIdentity(options.config, options.root);
  if (options.baseline !== undefined) {
    const plan = createReport(identity, options.tasks, [], options.config.trials);
    const issues = compatibilityIssues(options.baseline, plan, options.policy ?? STRICT_POLICY);
    if (issues.length > 0) throw new Error(`Incompatible evaluation: ${issues.join(' ')}`);
  }
  const factory = options.createLlm ?? createLlmFactory(options.config);
  await mkdir(path.dirname(options.config.out), { recursive: true });
  // Baselines are never overwritten by another run.
  await mkdir(options.config.out);
  writeFileSync(path.join(options.config.out, 'identity.json'), JSON.stringify(identity, null, 2));
  const pending = options.tasks.flatMap((task) =>
    Array.from({ length: options.config.trials }, (_, index) => ({ task, attempt: index + 1 })),
  );
  const results: TrialResult[] = [];
  const consume = async (): Promise<void> => {
    for (;;) {
      const job = pending.shift();
      if (job === undefined) return;
      const result = await runTrial({ config: options.config, ...job, llm: factory(job.task) });
      results.push(result);
      appendFileSync(path.join(options.config.out, 'results.jsonl'), `${JSON.stringify(result)}\n`);
      options.onTrial?.(result);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.config.concurrency, pending.length) }, consume),
  );
  results.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.attempt - b.attempt);
  const report = createReport(identity, options.tasks, results, options.config.trials);
  await writeReport(options.config.out, report);
  return report;
}
