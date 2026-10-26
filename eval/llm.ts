import Anthropic from '@anthropic-ai/sdk';
import { AnthropicLlm } from '../src/adapters/anthropic/anthropic-llm.js';
import type { LlmPort, LlmStreamEvent } from '../src/domain/ports/llm.js';
import type { EvalConfig, EvalTask } from './types.js';

class ReferenceLlm implements LlmPort {
  readonly #replies: readonly string[];
  #index = 0;

  constructor(task: EvalTask) {
    this.#replies = task.reference;
  }

  async *stream(): AsyncIterable<LlmStreamEvent> {
    const text = this.#replies[this.#index++];
    if (text === undefined) {
      throw new Error('Reference solution exhausted; inspect the trace and task.');
    }
    yield { type: 'text', text };
    yield { type: 'done', stopReason: 'end_turn' };
  }
}

export function createLlmFactory(config: EvalConfig): (task: EvalTask) => LlmPort {
  if (config.mode === 'reference') {
    return (task) => new ReferenceLlm(task);
  }
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const authToken = process.env['ANTHROPIC_AUTH_TOKEN'];
  if (!apiKey?.trim() && !authToken?.trim()) {
    throw new Error('Live evaluation requires ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.');
  }
  const client = new Anthropic({
    ...(apiKey?.trim() ? { apiKey } : {}),
    ...(authToken?.trim() ? { authToken } : {}),
    baseURL: config.endpoint,
    timeout: config.budget.timeoutMs,
  });
  return () => new AnthropicLlm({ client, model: config.model, effort: config.effort });
}
