import type Anthropic from '@anthropic-ai/sdk';
import type {
  LlmPort,
  LlmRequest,
  LlmStopReason,
  LlmStreamEvent,
  LlmUsage,
} from '../../domain/ports/llm.js';

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

    const tracker = new UsageTracker();
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
        continue;
      }
      if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
        yield { type: 'thinking', text: event.delta.thinking };
        continue;
      }
      const done = tracker.read(event);
      if (done !== undefined) {
        yield done;
      }
    }

    // A stream that ends without ever saying why still gets its `done`.
    const done = tracker.flush();
    if (done !== undefined) {
      yield done;
    }
  }
}

/**
 * The usage of one stream, as the message envelope reports it.
 *
 * The counters are cumulative and travel on two events: `message_start`
 * opens with the prompt, `message_delta` closes with the final totals. A
 * gateway is free to put them on either - some send zeroes at the start and
 * the real numbers with the stop reason - so both are folded, and the last
 * value reported for each field wins.
 */
class UsageTracker {
  #input: number | undefined;
  #cacheRead: number | undefined;
  #cacheWrite: number | undefined;
  #output: number | undefined;
  #reported = false;

  /** Fold one upstream event. A `done` comes back once the stream says why it stopped. */
  read(event: Anthropic.Messages.RawMessageStreamEvent): LlmStreamEvent | undefined {
    if (event.type === 'message_start') {
      this.#fold(event.message.usage);
      return undefined;
    }
    if (event.type === 'message_delta') {
      this.#fold(event.usage);
      if (event.delta.stop_reason === null) {
        return undefined;
      }
      this.#reported = true;
      const usage = this.#usage();
      return {
        type: 'done',
        stopReason: toStopReason(event.delta.stop_reason),
        ...(usage !== undefined ? { usage } : {}),
      };
    }
    return undefined;
  }

  /** The `done` for a stream that never gave a reason, with what was known by then. */
  flush(): LlmStreamEvent | undefined {
    if (this.#reported) {
      return undefined;
    }
    const usage = this.#usage();
    return {
      type: 'done',
      stopReason: 'other',
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  /** Take what this event knows. A field it did not report leaves the old value alone. */
  #fold(raw: RawUsage | null | undefined): void {
    if (raw === null || raw === undefined) {
      return;
    }
    if (typeof raw.input_tokens === 'number') {
      this.#input = raw.input_tokens;
    }
    if (typeof raw.cache_read_input_tokens === 'number') {
      this.#cacheRead = raw.cache_read_input_tokens;
    }
    if (typeof raw.cache_creation_input_tokens === 'number') {
      this.#cacheWrite = raw.cache_creation_input_tokens;
    }
    if (typeof raw.output_tokens === 'number') {
      this.#output = raw.output_tokens;
    }
  }

  /**
   * What the call cost, or nothing when the endpoint never accounted for
   * the prompt. A run of zeroes is not a prompt of zero tokens: it is an
   * endpoint that did not say, and the bar is better off silent than
   * claiming an empty context.
   */
  #usage(): LlmUsage | undefined {
    const cacheRead = this.#cacheRead ?? 0;
    const cacheWrite = this.#cacheWrite ?? 0;
    const input = (this.#input ?? 0) + cacheRead + cacheWrite;
    if (input <= 0) {
      return undefined;
    }
    // The input counts cache reads and writes too: those tokens are in the
    // conversation whether they were billed at full price or not. Whether
    // any cache accounting was reported is kept, so a gateway without
    // caching is not reported as a gateway with a zero percent hit rate.
    const cacheAccounted = this.#cacheRead !== undefined || this.#cacheWrite !== undefined;
    return {
      input,
      output: this.#output ?? 0,
      ...(cacheAccounted ? { cached: cacheRead } : {}),
    };
  }
}

/** The usage fields the API reports on a message. Anything may be absent: gateways. */
interface RawUsage {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
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
