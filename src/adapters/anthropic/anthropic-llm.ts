import type Anthropic from '@anthropic-ai/sdk';
import type { LlmPort, LlmRequest, LlmStopReason, LlmStreamEvent } from '../../domain/ports/llm.js';

export interface AnthropicLlmOptions {
  readonly client: Anthropic;
  readonly model: string;
}

/**
 * The Anthropic adapter.
 *
 * Note what is *not* here: no tool definitions. The agent has no tools, so
 * the request carries nothing but a system prompt and a conversation, and the
 * reply is JavaScript.
 */
export class AnthropicLlm implements LlmPort {
  readonly #client: Anthropic;
  readonly #model: string;

  constructor(options: AnthropicLlmOptions) {
    this.#client = options.client;
    this.#model = options.model;
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const stream = this.#client.messages.stream(
      {
        model: this.#model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.text,
        })),
      },
      { signal },
    );

    let reported = false;

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
        continue;
      }
      if (event.type === 'message_delta' && event.delta.stop_reason !== null) {
        reported = true;
        yield { type: 'done', stopReason: toStopReason(event.delta.stop_reason) };
      }
    }

    if (!reported) {
      yield { type: 'done', stopReason: 'other' };
    }
  }
}

function toStopReason(reason: string): LlmStopReason {
  switch (reason) {
    case 'end_turn':
    case 'max_tokens':
    case 'stop_sequence':
      return reason;
    default:
      return 'other';
  }
}
