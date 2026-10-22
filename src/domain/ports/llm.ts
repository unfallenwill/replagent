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

export type LlmStreamEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'done'; readonly stopReason: LlmStopReason };

export interface LlmPort {
  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent>;
}
