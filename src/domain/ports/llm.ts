/**
 * The language boundary of the agent.
 *
 * The agent has no tools: it can only speak JavaScript, and the REPL is the
 * only thing that executes it. This port is therefore deliberately tiny - it
 * hands over a conversation and receives JavaScript back.
 */

export type LlmRole = 'user' | 'assistant';

/**
 * How much room the model is given to think, on providers that grade it.
 *
 * The ladder is MiniMax-M3.1-Flash's. `max` is that model's own default, and
 * `none` is deliberately absent: the model rejects it outright.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * A block of the model's reasoning, as the provider reported it.
 *
 * The text is for the transcript; the signature is opaque and exists only to
 * travel back with the block. Providers that sign their reasoning reject a
 * block that came back altered or unsigned, so the two are kept together.
 */
export interface LlmThinkingBlock {
  readonly text: string;
  /** The provider's proof for this block, when it issued one. */
  readonly signature?: string;
}

export interface LlmMessage {
  readonly role: LlmRole;
  readonly text: string;
  /**
   * The reasoning that preceded this message's text, in the order it was
   * produced. It is replayed verbatim on the next request: interleaved
   * thinking depends on the model seeing its own thoughts, signatures and all.
   */
  readonly thinking?: readonly LlmThinkingBlock[];
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
  /** A chunk of the model's reasoning, when the model exposes it. */
  | { readonly type: 'thinking'; readonly text: string }
  | {
      readonly type: 'done';
      readonly stopReason: LlmStopReason;
      readonly usage?: LlmUsage;
      /** The whole reasoning of the reply, to be kept with the assistant turn. */
      readonly thinking?: readonly LlmThinkingBlock[];
    };

export interface LlmPort {
  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent>;
}
