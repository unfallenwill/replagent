import type { LlmUsage } from '../src/domain/ports/llm.js';
import type { UiEvent } from '../src/domain/ports/ui.js';
import type { TrialMetrics } from './types.js';

export class Metrics {
  calls = 0;
  #accounted = 0;
  #input = 0;
  #output = 0;
  #cached = 0;
  #cacheKnown = true;
  #steps = 0;
  #tools = 0;
  #errors = 0;

  usage(usage: LlmUsage | undefined): void {
    if (usage === undefined) {
      return;
    }
    this.#accounted += 1;
    this.#input += usage.input;
    this.#output += usage.output;
    this.#cached += usage.cached ?? 0;
    this.#cacheKnown &&= usage.cached !== undefined;
  }

  ui(event: UiEvent): void {
    if (event.type === 'step') this.#steps += 1;
    if (event.type === 'tool') this.#tools += 1;
    if (event.type === 'repl-error') this.#errors += 1;
  }

  result(wallMs: number): TrialMetrics {
    const known = this.calls > 0 && this.calls === this.#accounted;
    return {
      wallMs,
      calls: this.calls,
      inputTokens: known ? this.#input : null,
      outputTokens: known ? this.#output : null,
      cachedTokens: known && this.#cacheKnown ? this.#cached : null,
      steps: this.#steps,
      toolCalls: this.#tools,
      replErrors: this.#errors,
    };
  }
}
