import { type ChildProcess, fork } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LlmPort, LlmStreamEvent } from '../src/domain/ports/llm.js';
import { installFixtures, snapshot } from './files.js';
import { cleanEnvironment, grade } from './graders.js';
import { Metrics } from './metrics.js';
import { stopProcess } from './process.js';
import type { FromWorker, ToWorker } from './protocol.js';
import type { Answer, EvalConfig, EvalTask, TrialResult } from './types.js';

type Outcome = Pick<TrialResult, 'status' | 'error'>;
type Trace = (event: object) => void;

export interface TrialOptions {
  readonly config: EvalConfig;
  readonly task: EvalTask;
  readonly attempt: number;
  readonly llm: LlmPort;
}

export async function runTrial(options: TrialOptions): Promise<TrialResult> {
  const { config, task, attempt } = options;
  const artifacts = path.join('trials', task.id, String(attempt));
  const directory = path.join(config.out, artifacts);
  await mkdir(directory, { recursive: true });
  const workspace = await mkdtemp(path.join(tmpdir(), 'replagent-eval-'));
  const trace: Trace = (event) =>
    appendFileSync(
      path.join(directory, 'trace.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    );
  try {
    await installFixtures(workspace, task.fixtures);
    const answers: Answer[] = [];
    const metrics = new Metrics();
    const started = performance.now();
    const outcome = await executeTrial(options, workspace, answers, metrics, trace);
    const wallMs = Math.round(performance.now() - started);
    const checks = await grade(task, workspace, answers);
    await writeFile(
      path.join(directory, 'final-files.json'),
      JSON.stringify(await snapshot(workspace), null, 2),
    );
    const result: TrialResult = {
      taskId: task.id,
      attempt,
      ...outcome,
      passed: outcome.status === 'completed' && checks.every((check) => check.passed),
      checks,
      metrics: metrics.result(wallMs),
      artifacts: artifacts.split(path.sep).join('/'),
    };
    await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function executeTrial(
  options: TrialOptions,
  workspace: string,
  answers: Answer[],
  metrics: Metrics,
  trace: Trace,
): Promise<Outcome> {
  const child = fork(fileURLToPath(new URL('./worker.ts', import.meta.url)), [], {
    cwd: workspace,
    execArgv: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href],
    env: cleanEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const controller = new AbortController();
  let finish: (outcome: Outcome) => void = () => {};
  const completed = new Promise<Outcome>((resolve) => {
    let settled = false;
    finish = (outcome) => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };
  });
  const timer = setTimeout(
    () =>
      finish({
        status: 'timeout',
        error: `Trial exceeded ${options.config.budget.timeoutMs}ms.`,
      }),
    options.config.budget.timeoutMs,
  );
  collectOutput(child, trace);
  child.on('error', (error) => finish({ status: 'error', error: error.message }));
  child.on('exit', (code, signal) =>
    finish({ status: 'error', error: `Worker exited before completion: ${signal ?? code}` }),
  );
  child.on('message', (message: FromWorker) => {
    handleMessage(message, { options, child, controller, answers, metrics, trace, finish });
  });
  try {
    send(child, {
      type: 'start',
      candidate: options.config.candidate,
      systemPrompt: options.config.systemPrompt,
      budget: options.config.budget,
      turns: options.task.turns,
    });
    return await completed;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await stopProcess(child);
  }
}

interface Bridge {
  readonly options: TrialOptions;
  readonly child: ChildProcess;
  readonly controller: AbortController;
  readonly answers: Answer[];
  readonly metrics: Metrics;
  readonly trace: Trace;
  readonly finish: (outcome: Outcome) => void;
}

function handleMessage(message: FromWorker, bridge: Bridge): void {
  bridge.trace(message);
  switch (message.type) {
    case 'llm.request':
      void forwardRequest(message, bridge).catch((error: unknown) =>
        bridge.finish({
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    case 'ui':
      bridge.metrics.ui(message.event);
      if (message.event.type === 'say') {
        bridge.answers.push({ turn: message.turn, text: message.event.text });
      }
      return;
    case 'finished':
      bridge.finish({ status: 'completed' });
      return;
    case 'error':
      bridge.finish({ status: 'error', error: message.error });
      return;
    default:
      return;
  }
}

async function forwardRequest(
  message: Extract<FromWorker, { type: 'llm.request' }>,
  bridge: Bridge,
): Promise<void> {
  if (bridge.controller.signal.aborted) return;
  if (message.request.maxTokens > bridge.options.config.budget.maxTokens) {
    bridge.finish({ status: 'budget', error: 'Requested output tokens exceed the trial budget.' });
    return;
  }
  if (bridge.metrics.calls >= bridge.options.config.budget.maxCalls) {
    bridge.finish({ status: 'budget', error: 'Exceeded the trial model-call budget.' });
    return;
  }
  bridge.metrics.calls += 1;
  const events: LlmStreamEvent[] = [];
  let accounted = false;
  for await (const event of bridge.options.llm.stream(message.request, bridge.controller.signal)) {
    events.push(event);
    bridge.trace({ type: 'llm.event', id: message.id, event });
    if (event.type === 'done' && !accounted) {
      bridge.metrics.usage(event.usage);
      accounted = true;
    }
  }
  send(bridge.child, { type: 'llm.result', id: message.id, events });
}

function send(child: ChildProcess, message: ToWorker): void {
  if (child.connected) {
    child.send(message, () => {});
  }
}

function collectOutput(child: ChildProcess, trace: Trace): void {
  for (const [stream, name] of [
    [child.stdout, 'stdout'],
    [child.stderr, 'stderr'],
  ] as const) {
    let remaining = 64_000;
    stream?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().slice(0, remaining);
      remaining -= text.length;
      if (text.length > 0) trace({ type: 'worker.output', stream: name, text });
    });
  }
}
