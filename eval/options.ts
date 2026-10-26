import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SYSTEM_PROMPT } from '../src/app/prompt.js';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../src/cli/args.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../src/domain/ports/llm.js';
import type { ComparePolicy } from './report.js';
import type { EvalConfig, EvalMode } from './types.js';

const FLAGS = {
  help: { type: 'boolean', short: 'h' },
  mode: { type: 'string' },
  suite: { type: 'string' },
  partition: { type: 'string' },
  task: { type: 'string', multiple: true },
  tasks: { type: 'string' },
  trials: { type: 'string' },
  concurrency: { type: 'string' },
  'timeout-ms': { type: 'string' },
  'max-calls': { type: 'string' },
  'max-steps': { type: 'string' },
  'max-tokens': { type: 'string' },
  model: { type: 'string' },
  'base-url': { type: 'string' },
  effort: { type: 'string' },
  candidate: { type: 'string' },
  'prompt-file': { type: 'string' },
  out: { type: 'string' },
  baseline: { type: 'string' },
  'max-pass-rate-drop': { type: 'string' },
  'max-token-ratio': { type: 'string' },
  'max-latency-ratio': { type: 'string' },
  'allow-model-change': { type: 'boolean' },
} as const;

type Values = ReturnType<typeof parsed>['values'];

function parsed(
  argv: readonly string[],
): ReturnType<typeof parseArgs<{ options: typeof FLAGS; allowPositionals: true }>> {
  return parseArgs({ args: [...argv], options: FLAGS, allowPositionals: true, strict: true });
}

export interface EvalOptions {
  readonly command: 'run' | 'list' | 'compare' | 'help';
  readonly config: EvalConfig;
  readonly suite: string;
  readonly partition: string;
  readonly selectors: readonly string[];
  readonly tasksFile: string | undefined;
  readonly baseline: string | undefined;
  readonly current: string | undefined;
  readonly policy: ComparePolicy;
}

export async function parseEvalArgs(argv: readonly string[], root: string): Promise<EvalOptions> {
  const { values, positionals } = parsed(argv);
  const command = commandOf(values, positionals);
  const suite = suiteOf(values.suite);
  validatePositionals(command, positionals);
  const baseline = command === 'compare' ? positionals[1] : values.baseline;
  const current = command === 'compare' ? positionals[2] : undefined;
  return {
    command: command as EvalOptions['command'],
    config: await makeConfig(values, root),
    suite,
    partition: partitionOf(values.partition),
    selectors: values.task ?? [],
    tasksFile: optionalPath(root, values.tasks),
    baseline: optionalPath(root, baseline),
    current: optionalPath(root, current),
    policy: makePolicy(values),
  };
}

function optionalPath(root: string, file: string | undefined): string | undefined {
  return file === undefined ? undefined : path.resolve(root, file);
}

function commandOf(values: Values, positionals: readonly string[]): string {
  const command = values.help ? 'help' : (positionals[0] ?? 'run');
  if (!['run', 'list', 'compare', 'help'].includes(command))
    throw new Error(`Unknown command: ${command}`);
  return command;
}

function suiteOf(value: string | undefined): string {
  const suite = value ?? 'all';
  if (!['all', 'regression', 'capability'].includes(suite))
    throw new Error(`Unknown suite: ${suite}`);
  return suite;
}

function partitionOf(value: string | undefined): string {
  const partition = value ?? 'all';
  if (!['all', 'development', 'holdout'].includes(partition))
    throw new Error('Unknown --partition; use all, development, or holdout.');
  return partition;
}

function validatePositionals(command: string, args: readonly string[]): void {
  if (command === 'compare' && args.length !== 3) {
    throw new Error('Usage: compare <baseline/report.json> <current/report.json>');
  }
  if (command !== 'compare' && args.length > 1) throw new Error('Unexpected positional arguments.');
}

async function makeConfig(values: Values, root: string): Promise<EvalConfig> {
  const mode = values.mode ?? 'live';
  if (mode !== 'live' && mode !== 'reference') throw new Error('--mode must be live or reference.');
  const effort = values.effort ?? 'max';
  if (!REASONING_EFFORTS.includes(effort as ReasoningEffort)) throw new Error('Invalid --effort.');
  const prompt = values['prompt-file'];
  return {
    mode: mode as EvalMode,
    ...modelOptions(values),
    effort: effort as ReasoningEffort,
    trials: integer(values.trials, 3, '--trials'),
    concurrency: integer(values.concurrency, 2, '--concurrency'),
    budget: {
      timeoutMs: integer(values['timeout-ms'], 180_000, '--timeout-ms'),
      maxCalls: integer(values['max-calls'], 24, '--max-calls'),
      maxSteps: integer(values['max-steps'], 12, '--max-steps'),
      maxTokens: integer(values['max-tokens'], 8192, '--max-tokens'),
    },
    candidate: path.resolve(root, values.candidate ?? 'eval/candidate.ts'),
    systemPrompt:
      prompt === undefined ? SYSTEM_PROMPT : await readFile(path.resolve(root, prompt), 'utf8'),
    out: path.resolve(
      root,
      values.out ??
        `.evals/runs/${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}`,
    ),
  };
}

function modelOptions(values: Values): Pick<EvalConfig, 'model' | 'endpoint'> {
  return {
    model: values.model ?? process.env['ANTHROPIC_MODEL'] ?? DEFAULT_MODEL,
    endpoint: values['base-url'] ?? process.env['ANTHROPIC_BASE_URL'] ?? DEFAULT_BASE_URL,
  };
}

function makePolicy(values: Values): ComparePolicy {
  const drop = decimal(values['max-pass-rate-drop'] ?? '0', '--max-pass-rate-drop');
  if (drop > 1) throw new Error('--max-pass-rate-drop must be between 0 and 1.');
  const token = values['max-token-ratio'];
  const latency = values['max-latency-ratio'];
  return {
    maxPassRateDrop: drop,
    allowModelChange: values['allow-model-change'] ?? false,
    ...(token === undefined ? {} : { maxTokenRatio: positiveDecimal(token, '--max-token-ratio') }),
    ...(latency === undefined
      ? {}
      : { maxLatencyRatio: positiveDecimal(latency, '--max-latency-ratio') }),
  };
}

function integer(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1)
    throw new Error(`${flag} must be a positive integer.`);
  return number;
}

function decimal(value: string, flag: string): number {
  const number = Number(value);
  if (value.trim() === '' || !Number.isFinite(number) || number < 0)
    throw new Error(`${flag} must be a nonnegative number.`);
  return number;
}

function positiveDecimal(value: string, flag: string): number {
  const number = decimal(value, flag);
  if (number === 0) throw new Error(`${flag} must be positive.`);
  return number;
}

export const EVAL_HELP: string = [
  'replagent evaluations',
  '',
  'npm run eval -- list',
  'npm run eval -- run [options]',
  'npm run eval -- compare baseline/report.json current/report.json [thresholds]',
  '',
  '--mode live|reference          Real model or offline reference self-check (default: live)',
  '--trials N                     Independent attempts per task (default: 3)',
  '--concurrency N                Concurrent trials (default: 2)',
  '--suite all|regression|capability',
  '--partition all|development|holdout',
  '--task ID-OR-PREFIX             Filter tasks; repeat to select several',
  '--tasks MODULE                 A module exporting TASKS for a custom suite',
  '--candidate MODULE             A module exporting createSubject(context)',
  '--prompt-file FILE             Replace the candidate system prompt',
  '--model ID --base-url URL --effort LEVEL',
  '--timeout-ms N --max-calls N --max-steps N --max-tokens N',
  '--out DIRECTORY                Fresh artifact directory; existing directories are refused',
  '--baseline REPORT              Compare after running; never update the baseline',
  '--max-pass-rate-drop R         Allowed per-task/check decrease (default: 0)',
  '--max-token-ratio R            Optional maximum tokens/success ratio',
  '--max-latency-ratio R          Optional maximum latency ratio',
  '--allow-model-change           Explicitly compare different models/endpoints/effort',
  '',
  'Exit: 0 = passed, 1 = failed task/regression, 2 = invalid/incompatible evaluation.',
  'npm scripts load .env.local; credentials are kept out of the agent worker.',
  '',
].join('\n');
