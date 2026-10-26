import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskHash, workspacePath } from '../eval/files.js';
import { Metrics } from '../eval/metrics.js';
import { parseEvalArgs } from '../eval/options.js';
import {
  compareReports,
  hasRequiredFailures,
  readReport,
  renderReport,
  STRICT_POLICY,
  tokensPerSuccess,
} from '../eval/report.js';
import { TASKS, validateTasks } from '../eval/tasks.js';
import { EVAL_ROOT, fixtureReport, OUTPUT_TASK, required, trialResult } from './eval-fixtures.js';

let directory = '';
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'replagent-eval-unit-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('evaluation regression gates', () => {
  it('detects a previously solved task becoming unreliable', () => {
    const before = fixtureReport([trialResult(true, 1), trialResult(true, 2)]);
    const after = fixtureReport([trialResult(true, 1), trialResult(false, 2)]);
    const result = compareReports(before, after);
    expect(result.compatible).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.regressions.join()).toContain('100.0% -> 50.0%');
  });

  it('detects a lost check even when overall task pass rates are unchanged', () => {
    const original = fixtureReport([trialResult(false)]);
    const baseline = {
      ...original,
      tasks: [{ ...required(original.tasks[0]), checkPassRates: { first: 1, second: 0 } }],
    };
    const current = {
      ...original,
      tasks: [{ ...required(original.tasks[0]), checkPassRates: { first: 0, second: 1 } }],
    };
    expect(compareReports(baseline, current).regressions.join()).toContain('/first');
  });

  it('permits a new task without hiding removed or changed old tasks', () => {
    const baseline = fixtureReport([trialResult(true)]);
    const old = required(baseline.tasks[0]);
    const current = { ...baseline, tasks: [...baseline.tasks, { ...old, id: 'test/new' }] };
    expect(compareReports(baseline, current)).toMatchObject({
      passed: true,
      addedTasks: ['test/new'],
    });
    expect(compareReports(baseline, { ...baseline, tasks: [] }).compatible).toBe(false);
    expect(
      compareReports(baseline, { ...baseline, tasks: [{ ...old, hash: 'changed' }] }).issues.join(),
    ).toContain('definition changed');
  });

  it('lets compatible prompt and harness versions evolve together', () => {
    const baseline = fixtureReport([trialResult(true)]);
    const current = {
      ...baseline,
      sourceHash: 'new-source',
      promptHash: 'new-prompt',
      candidate: { path: 'other.ts', hash: 'new' },
    };
    expect(compareReports(baseline, current).passed).toBe(true);
  });

  it('requires new regression tasks to pass while allowing new capability targets', () => {
    const baseline = fixtureReport([trialResult(true)]);
    const added = {
      ...required(baseline.tasks[0]),
      id: 'test/new',
      passed: 0,
      checkPassRates: { result: 0 },
    };
    expect(
      compareReports(baseline, { ...baseline, tasks: [...baseline.tasks, added] }).passed,
    ).toBe(false);
    expect(
      compareReports(baseline, {
        ...baseline,
        tasks: [...baseline.tasks, { ...added, suite: 'capability' }],
      }).passed,
    ).toBe(true);
  });

  it('refuses misleading comparisons of budgets, trial counts, or offline scores', () => {
    const baseline = fixtureReport([trialResult(true)]);
    expect(compareReports(baseline, { ...baseline, mode: 'reference' }).compatible).toBe(false);
    expect(
      compareReports(baseline, { ...baseline, budget: { ...baseline.budget, maxCalls: 99 } })
        .compatible,
    ).toBe(false);
    expect(
      compareReports(baseline, {
        ...baseline,
        tasks: [{ ...required(baseline.tasks[0]), trials: 9 }],
      }).compatible,
    ).toBe(false);
  });

  it('requires an explicit decision to compare different models', () => {
    const baseline = fixtureReport([trialResult(true)]);
    const current = { ...baseline, model: 'another-model' };
    expect(compareReports(baseline, current).compatible).toBe(false);
    expect(
      compareReports(baseline, current, { ...STRICT_POLICY, allowModelChange: true }).passed,
    ).toBe(true);
  });

  it('refuses to silently change the grader while comparing agent versions', () => {
    const baseline = fixtureReport([trialResult(true)]);
    expect(compareReports(baseline, { ...baseline, graderHash: 'another-grader' }).compatible).toBe(
      false,
    );
  });

  it('keeps old basic reports compatible while protecting versioned checkpoint graders', () => {
    const baseline = fixtureReport([trialResult(true)]);
    const current = { ...baseline, checkpointHash: 'current-checkpoints' };
    expect(compareReports(baseline, current).passed).toBe(true);
    expect(
      compareReports({ ...baseline, checkpointHash: 'old-checkpoints' }, current).issues.join(),
    ).toContain('Checkpoint implementation changed');
  });

  it('supports explicit noise tolerance and efficiency gates', () => {
    const baseline = fixtureReport([trialResult(true, 1), trialResult(true, 2)]);
    const after = fixtureReport([trialResult(true, 1), trialResult(false, 2)]);
    expect(compareReports(baseline, after, { ...STRICT_POLICY, maxPassRateDrop: 0.5 }).passed).toBe(
      true,
    );
    expect(
      compareReports(baseline, after, {
        ...STRICT_POLICY,
        maxPassRateDrop: 0.5,
        maxTokenRatio: 1.5,
      }).regressions.join(),
    ).toContain('tokens/success');
  });

  it('keeps capability failures visible without treating them as mastered abilities', () => {
    const baseline = fixtureReport([trialResult(true)]);
    const before = {
      ...baseline,
      tasks: [{ ...required(baseline.tasks[0]), suite: 'capability' as const }],
    };
    const current = {
      ...fixtureReport([trialResult(false)]),
      tasks: [{ ...required(before.tasks[0]), passed: 0, checkPassRates: { result: 0 } }],
    };
    expect(compareReports(before, current).passed).toBe(true);
  });
});

describe('evaluation accounting and task validity', () => {
  it('counts failed attempts in the cost per success', () => {
    expect(tokensPerSuccess([trialResult(true, 1), trialResult(false, 2)])).toBe(240);
    const unknown = trialResult(true);
    expect(
      tokensPerSuccess([{ ...unknown, metrics: { ...unknown.metrics, inputTokens: null } }]),
    ).toBeNull();
  });

  it('does not call missing provider usage zero tokens', () => {
    const metrics = new Metrics();
    metrics.calls = 2;
    metrics.usage({ input: 100, output: 20 });
    metrics.usage(undefined);
    expect(metrics.result(10)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
    });
  });

  it('does not double-count usage emitted by the UI', () => {
    const metrics = new Metrics();
    metrics.calls = 1;
    metrics.usage({ input: 100, output: 20, cached: 80 });
    metrics.ui({ type: 'turn-usage', usage: { input: 100, output: 20, cached: 80 } });
    expect(metrics.result(10)).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 80,
    });
  });

  it('fingerprints the task and grading contract independently from its reference solution', () => {
    expect(taskHash({ ...OUTPUT_TASK, reference: ['another solution'] })).toBe(
      taskHash(OUTPUT_TASK),
    );
    expect(taskHash({ ...OUTPUT_TASK, turns: ['different task'] })).not.toBe(taskHash(OUTPUT_TASK));
    expect(() => validateTasks([...TASKS, required(TASKS[0])])).toThrow(/Duplicate/);
    expect(() => workspacePath(directory, '../escape.txt')).toThrow(/workspace-relative/);
  });

  it('validates report counters rather than trusting a claimed success rate', async () => {
    const report = fixtureReport([trialResult(false)]);
    const file = path.join(directory, 'report.json');
    await writeFile(file, JSON.stringify(report));
    expect((await readReport(file)).tasks[0]?.passed).toBe(0);
    await writeFile(
      file,
      JSON.stringify({ ...report, tasks: [{ ...required(report.tasks[0]), passed: 1 }] }),
    );
    await expect(readReport(file)).rejects.toThrow(/Invalid evaluation report/);
    await writeFile(file, '{"schema":1,"tasks":[{}]}');
    await expect(readReport(file)).rejects.toThrow(/Invalid evaluation report/);
  });

  it('labels reference results as self-checks and retains failure evidence', () => {
    const report = { ...fixtureReport([trialResult(false)]), mode: 'reference' as const };
    expect(renderReport(report)).toContain('NOT model capability');
    expect(renderReport(report)).toContain('trials/test/output/1');
  });

  it('requires every reference solution to work, including capability tasks', () => {
    const report = fixtureReport([trialResult(false)]);
    const capability = {
      ...report,
      tasks: [{ ...required(report.tasks[0]), suite: 'capability' as const }],
    };
    expect(hasRequiredFailures(capability)).toBe(false);
    expect(hasRequiredFailures({ ...capability, mode: 'reference' })).toBe(true);
  });
});

describe('evaluation CLI configuration', () => {
  it('rejects typos and invalid budgets before making a model call', async () => {
    for (const args of [
      ['run', '--trials', '0'],
      ['run', '--max-calls', '-2'],
      ['run', '--concurrency', '1.2'],
      ['run', '--typo'],
      ['compare', 'one.json'],
    ]) {
      await expect(parseEvalArgs(args, EVAL_ROOT)).rejects.toThrow();
    }
  });

  it('loads an explicit prompt and keeps evaluation thresholds separate from the candidate', async () => {
    const file = path.join(directory, 'prompt.txt');
    await writeFile(file, 'minimal custom prompt');
    const options = await parseEvalArgs(
      [
        'run',
        '--mode',
        'reference',
        '--prompt-file',
        file,
        '--task',
        'files/',
        '--trials',
        '2',
        '--max-token-ratio',
        '1.2',
      ],
      EVAL_ROOT,
    );
    expect(options.config.systemPrompt).toBe('minimal custom prompt');
    expect(options.config.trials).toBe(2);
    expect(options.selectors).toEqual(['files/']);
    expect(options.policy.maxTokenRatio).toBe(1.2);
    expect(await readFile(file, 'utf8')).toBe('minimal custom prompt');
  });
});
