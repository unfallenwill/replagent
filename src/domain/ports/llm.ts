/**
 * The language boundary of the agent.
 *
 * The agent has no tools: it can only speak JavaScript, and the REPL is the
 * only thing that executes it. This port is therefore deliberately tiny - it
 * hands over a conversation and receives JavaScript back.
 */

export type LlmRole = 'user' | 'assistant';

export interface LlmMessage {
  readonly role: LlmRole;
  readonly text: string;
}

export interface LlmRequest {
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly maxTokens: number;
}

export type LlmStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'other';

/**
 * What one model call cost.
 *
 * The input is the prompt in total - plain input, cache reads and cache
 * writes put together - because that is the weight of the conversation,
 * not just the unbilled part of it.
 */
export interface LlmUsage {
  /** Prompt tokens in total, cache traffic included. */
  readonly input: number;
  /** Completion tokens of the reply. */
  readonly output: number;
  /** Prompt tokens served from the prompt cache. Present only when the API reports cache accounting at all. */
  readonly cached?: number;
}

export type LlmStreamEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'done'; readonly stopReason: LlmStopReason; readonly usage?: LlmUsage };

export interface LlmPort {
  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent>;
}
