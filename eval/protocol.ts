import type { LlmRequest, LlmStreamEvent } from '../src/domain/ports/llm.js';
import type { UiEvent } from '../src/domain/ports/ui.js';
import type { EvalBudget } from './types.js';

export type ToWorker =
  | {
      readonly type: 'start';
      readonly candidate: string;
      readonly systemPrompt: string;
      readonly budget: EvalBudget;
      readonly turns: readonly string[];
    }
  | { readonly type: 'llm.result'; readonly id: number; readonly events: readonly LlmStreamEvent[] }
  | { readonly type: 'llm.error'; readonly id: number; readonly error: string }
  | { readonly type: 'turn.continue'; readonly turn: number };

export type FromWorker =
  | { readonly type: 'llm.request'; readonly id: number; readonly request: LlmRequest }
  | { readonly type: 'ui'; readonly turn: number; readonly event: UiEvent }
  | { readonly type: 'turn.start' | 'turn.end'; readonly turn: number }
  | { readonly type: 'finished' }
  | { readonly type: 'error'; readonly error: string };
