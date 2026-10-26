import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalConfig, EvalReport, EvalTask, TrialResult } from '../eval/types.js';
import { SYSTEM_PROMPT } from '../src/app/prompt.js';
import type { LlmPort, LlmStreamEvent } from '../src/domain/ports/llm.js';

export const EVAL_ROOT: string = fileURLToPath(new URL('../', import.meta.url));

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture.');
  return value;
}

export function program(body: string): string {
  return `await step("test", "exercise behavior", async () => { ${body} });`;
}

export class SequenceLlm implements LlmPort {
  readonly #replies: readonly string[];
  #index = 0;

  constructor(replies: readonly string[]) {
    this.#replies = replies;
  }

  async *stream(): AsyncIterable<LlmStreamEvent> {
    const text = this.#replies[this.#index++];
    if (text === undefined) throw new Error('Unexpected additional model request.');
    yield { type: 'text', text };
    yield { type: 'done', stopReason: 'end_turn', usage: { input: 100, output: 20 } };
  }
}

export const OUTPUT_TASK: EvalTask = {
  id: 'test/output',
  suite: 'regression',
  description: 'Write a real artifact.',
  fixtures: { 'KEEP.txt': 'original' },
  turns: ['Write result.txt containing exactly correct. Preserve KEEP.txt.'],
  checks: [
    { id: 'result', type: 'file', path: 'result.txt', content: 'correct' },
    { id: 'protected', type: 'unchanged', path: 'KEEP.txt' },
  ],
  reference: [program('require("node:fs").writeFileSync("result.txt","correct"); say("Done");')],
};

export function evalConfig(out: string, overrides: Partial<EvalConfig> = {}): EvalConfig {
  return {
    mode: 'reference',
    model: 'test-model',
    endpoint: 'https://example.invalid',
    effort: 'max',
    trials: 1,
    concurrency: 2,
    budget: { timeoutMs: 20_000, maxCalls: 4, maxSteps: 4, maxTokens: 1000 },
    candidate: path.join(EVAL_ROOT, 'eval/candidate.ts'),
    systemPrompt: SYSTEM_PROMPT,
    out,
    ...overrides,
  };
}

export function trialResult(passed: boolean, attempt = 1): TrialResult {
  return {
    taskId: 'test/output',
    attempt,
    status: 'completed',
    passed,
    checks: [{ id: 'result', passed, detail: 'fixture' }],
    artifacts: `trials/test/output/${attempt}`,
    metrics: {
      wallMs: 1000,
      calls: 1,
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: null,
      steps: 1,
      toolCalls: 1,
      replErrors: 0,
    },
  };
}

export function fixtureReport(results: readonly TrialResult[]): EvalReport {
  const passed = results.filter((result) => result.passed).length;
  return {
    schema: 1,
    at: '2026-10-26T00:00:00.000Z',
    mode: 'live',
    model: 'test-model',
    endpoint: 'https://example.invalid',
    effort: 'max',
    budget: { timeoutMs: 20_000, maxCalls: 4, maxSteps: 4, maxTokens: 1000 },
    candidate: { path: 'eval/candidate.ts', hash: 'candidate' },
    promptHash: 'prompt',
    sourceHash: 'source',
    graderHash: 'grader',
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    tasks: [
      {
        id: 'test/output',
        suite: 'regression',
        hash: 'task',
        trials: results.length,
        passed,
        checkPassRates: { result: passed / results.length },
      },
    ],
    results,
  };
}
