import { type ChildProcess, fork } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LlmPort, LlmStreamEvent } from '../src/domain/ports/llm.js';
import { Checkpoints } from './checkpoints.js';
import { installFixtures, snapshot } from './files.js';
import { cleanEnvironment } from './graders.js';
import { Metrics } from './metrics.js';
import { stopProcess } from './process.js';
import { createProcessScope, type ProcessScope } from './process-scope.js';
import type { FromWorker, ToWorker } from './protocol.js';
import type { Answer, EvalConfig, EvalTask, TrialResult } from './types.js';
import { prepareWorkspace } from './workspace.js';

type Outcome = Pick<TrialResult, 'status' | 'error'>;
type Trace = (event: object) => void;

export interface TrialOptions {
  readonly config: EvalConfig;
  readonly task: EvalTask;
  readonly attempt: number;
  readonly llm: LlmPort;
}

export async function runTrial(options: TrialOptions): Promise<TrialResult> {
  try {
    return await runIsolatedTrial(options);
  } catch (error) {
    return infrastructureFailure(options, error);
  }
}

async function infrastructureFailure(options: TrialOptions, error: unknown): Promise<TrialResult> {
  const artifacts = path.join('trials', options.task.id, String(options.attempt));
  const directory = path.join(options.config.out, artifacts);
  let previous: TrialResult | undefined;
  try {
    previous = JSON.parse(
      await readFile(path.join(directory, 'result.json'), 'utf8'),
    ) as TrialResult;
  } catch {
    /* Setup can fail before a result exists. */
  }
  const result: TrialResult = {
    taskId: options.task.id,
    attempt: options.attempt,
    status: 'error',
    passed: false,
    error: `Evaluation infrastructure: ${error instanceof Error ? error.message : String(error)}`,
    checks:
      previous?.checks ??
      options.task.checks.map((check) => ({
        id: check.id,
        passed: false,
        detail: 'Evaluation did not complete.',
      })),
    metrics: previous?.metrics ?? new Metrics().result(0),
    artifacts: artifacts.split(path.sep).join('/'),
  };
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

async function runIsolatedTrial(options: TrialOptions): Promise<TrialResult> {
  const { config, task, attempt } = options;
  const artifacts = path.join('trials', task.id, String(attempt));
  const directory = path.join(config.out, artifacts);
  await mkdir(directory, { recursive: true });
  const trialRoot = await mkdtemp(path.join(tmpdir(), 'replagent-eval-'));
  const workspace = path.join(trialRoot, 'workspace');
  await mkdir(workspace);
  const checkpoints = new Checkpoints(task, workspace, directory, path.join(trialRoot, 'copies'));
  const trace: Trace = (event) =>
    appendFileSync(
      path.join(directory, 'trace.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    );
  try {
    await installFixtures(workspace, task.fixtures);
    await prepareWorkspace(task, workspace, directory);
    await checkpoints.prepare(0);
    const answers: Answer[] = [];
    const metrics = new Metrics();
    const started = performance.now();
    const outcome = await executeTrial(options, checkpoints, answers, metrics, trace);
    const wallMs = Math.round(performance.now() - started);
    await writeFile(
      path.join(directory, 'final-files.json'),
      JSON.stringify(await snapshot(workspace), null, 2),
    );
    const checks = await checkpoints.grade(answers);
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
    await rm(trialRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function executeTrial(
  options: TrialOptions,
  checkpoints: Checkpoints,
  answers: Answer[],
  metrics: Metrics,
  trace: Trace,
): Promise<Outcome> {
  const child = fork(fileURLToPath(new URL('./worker.ts', import.meta.url)), [], {
    cwd: checkpoints.workspace,
    execArgv: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href],
    env: cleanEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const controller = new AbortController();
  const boundaries: Promise<void>[] = [];
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
    handleMessage(message, {
      options,
      checkpoints,
      boundaries,
      child,
      controller,
      answers,
      metrics,
      trace,
      finish,
    });
  });
  let scope: ProcessScope | undefined;
  let outcome: Outcome = { status: 'error', error: 'Worker did not start.' };
  try {
    scope = await createProcessScope(child, trace);
    send(child, {
      type: 'start',
      candidate: options.config.candidate,
      systemPrompt: options.config.systemPrompt,
      budget: options.config.budget,
      turns: options.task.turns,
    });
    outcome = await completed;
  } catch (error) {
    outcome = { status: 'error', error: `Evaluation infrastructure: ${String(error)}` };
  } finally {
    clearTimeout(timer);
    controller.abort();
    try {
      if (scope === undefined) await stopProcess(child);
      else await scope.close();
    } catch (error) {
      outcome = { status: 'error', error: `Evaluation infrastructure cleanup: ${String(error)}` };
    }
    await Promise.all(boundaries);
  }
  return outcome;
}

interface Bridge {
  readonly options: TrialOptions;
  readonly checkpoints: Checkpoints;
  readonly boundaries: Promise<void>[];
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
    case 'turn.end':
      bridge.boundaries.push(
        continueAfterTurn(message.turn, bridge).catch((error: unknown) =>
          bridge.finish({ status: 'error', error: String(error) }),
        ),
      );
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

async function continueAfterTurn(turn: number, bridge: Bridge): Promise<void> {
  await bridge.checkpoints.capture(turn);
  await bridge.checkpoints.prepare(turn + 1);
  if (!bridge.controller.signal.aborted) send(bridge.child, { type: 'turn.continue', turn });
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
