import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runEvaluation } from '../eval/run.js';
import {
  EVAL_ROOT,
  evalConfig,
  OUTPUT_TASK,
  program,
  required,
  SequenceLlm,
} from './eval-fixtures.js';

let directory = '';
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'replagent-process-test-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it.runIf(process.platform === 'win32')(
  'cleans descendants left behind by a killed shell and continues the next trial',
  async () => {
    const payload = `require('node:fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},1000)`;
    const command = `node -e "${payload}"`;
    const orphan = {
      ...OUTPUT_TASK,
      id: 'test/orphan',
      reference: [
        program(
          `await bash(${JSON.stringify(command)},"exercise child timeout",{timeout:8000});say("Done");`,
        ),
      ],
    };
    const report = await runEvaluation({
      root: EVAL_ROOT,
      config: evalConfig(path.join(directory, 'run'), {
        concurrency: 1,
        budget: { timeoutMs: 20000, maxCalls: 2, maxSteps: 2, maxTokens: 1000 },
      }),
      tasks: [orphan, OUTPUT_TASK],
    });
    const failed = required(report.results.find((trial) => trial.taskId === orphan.id));
    expect(failed.status, failed.error).toBe('timeout');
    expect(report.results.find((trial) => trial.taskId === OUTPUT_TASK.id)?.passed).toBe(true);
    const snapshot = JSON.parse(
      await readFile(path.join(directory, 'run', failed.artifacts, 'final-files.json'), 'utf8'),
    ) as Record<string, { content: string }>;
    const pid = Number(required(snapshot['child.pid']).content);
    expect(() => process.kill(pid, 0)).toThrow();
    const trace = await readFile(
      path.join(directory, 'run', failed.artifacts, 'trace.jsonl'),
      'utf8',
    );
    expect(trace).toContain('"remaining":0');
  },
  45_000,
);

it('records a setup failure without aborting other task results', async () => {
  const broken = {
    ...OUTPUT_TASK,
    id: 'test/broken-setup',
    setup: { type: 'node-project' as const, lockHash: '0'.repeat(64) },
  };
  const report = await runEvaluation({
    root: EVAL_ROOT,
    config: evalConfig(path.join(directory, 'errors'), { concurrency: 1 }),
    tasks: [broken, OUTPUT_TASK],
    createLlm: () => new SequenceLlm(OUTPUT_TASK.reference),
  });
  expect(report.results.find((trial) => trial.taskId === broken.id)).toMatchObject({
    status: 'error',
    passed: false,
    metrics: { calls: 0 },
  });
  expect(report.results.find((trial) => trial.taskId === OUTPUT_TASK.id)?.passed).toBe(true);
}, 20_000);

it.runIf(process.platform === 'win32')(
  'cleans a history of many exited children without timing out',
  async () => {
    const code = program(
      `const cp=require('node:child_process');for(let wave=0;wave<10;wave++)await Promise.all(Array.from({length:8},()=>new Promise((resolve,reject)=>{cp.spawn(process.execPath,['-e','setTimeout(()=>{},1200)'],{stdio:'ignore',windowsHide:true}).on('exit',resolve).on('error',reject);})));require('node:fs').writeFileSync('result.txt','correct');say('Done');`,
    );
    const report = await runEvaluation({
      root: EVAL_ROOT,
      tasks: [OUTPUT_TASK],
      config: evalConfig(path.join(directory, 'history'), {
        budget: { timeoutMs: 120000, maxCalls: 1, maxSteps: 1, maxTokens: 1000 },
      }),
      createLlm: () => new SequenceLlm([code]),
    });
    expect(report.results[0]).toMatchObject({ status: 'completed', passed: true });
    const text = await readFile(
      path.join(directory, 'history', required(report.results[0]).artifacts, 'trace.jsonl'),
      'utf8',
    );
    const events = text
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            phase?: string;
            tracked?: number;
            remaining?: number;
          },
      );
    const closed = required(
      events.find((event) => event.type === 'process.scope' && event.phase === 'closed'),
    );
    expect(closed.tracked).toBeGreaterThanOrEqual(50);
    expect(closed.remaining).toBe(0);
  },
  135_000,
);
