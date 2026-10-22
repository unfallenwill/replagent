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
 * The start event fixes what the prompt weighed; the delta event adds the
 * final output count. The two travel on different schedules, and either
 * may never arrive.
 */
class UsageTracker {
  #usage: LlmUsage | undefined;
  #reported = false;

  /** Fold one upstream event. A `done` comes back once the stream says why it stopped. */
  read(event: Anthropic.Messages.RawMessageStreamEvent): LlmStreamEvent | undefined {
    if (event.type === 'message_start') {
      this.#usage = readUsage(event.message.usage);
      return undefined;
    }
    if (event.type === 'message_delta' && event.delta.stop_reason !== null) {
      this.#reported = true;
      // The delta carries the final output count; the input was fixed when
      // the stream started.
      const usage = this.#usage;
      this.#usage =
        usage === undefined ? undefined : { ...usage, output: event.usage.output_tokens };
      return {
        type: 'done',
        stopReason: toStopReason(event.delta.stop_reason),
        ...(this.#usage !== undefined ? { usage: this.#usage } : {}),
      };
    }
    return undefined;
  }

  /** The `done` for a stream that never gave a reason, with what was known by then. */
  flush(): LlmStreamEvent | undefined {
    if (this.#reported) {
      return undefined;
    }
    return {
      type: 'done',
      stopReason: 'other',
      ...(this.#usage !== undefined ? { usage: this.#usage } : {}),
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

/**
 * Read the prompt's weight and how much of it was cache.
 *
 * The input counts cache reads and writes too: those tokens are in the
 * conversation whether they were billed at full price or not. Whether any
 * cache accounting was reported is kept, so a gateway without caching is
 * not reported as a gateway with a zero percent hit rate.
 */
function readUsage(raw: RawUsage): LlmUsage {
  const input = raw.input_tokens ?? 0;
  const cacheRead = raw.cache_read_input_tokens ?? 0;
  const cacheWrite = raw.cache_creation_input_tokens ?? 0;
  const cacheReadReported =
    raw.cache_read_input_tokens !== undefined && raw.cache_read_input_tokens !== null;
  const cacheWriteReported =
    raw.cache_creation_input_tokens !== undefined && raw.cache_creation_input_tokens !== null;
  const cacheAccounted = cacheReadReported || cacheWriteReported;

  return {
    input: input + cacheRead + cacheWrite,
    output: raw.output_tokens ?? 0,
    ...(cacheAccounted ? { cached: cacheRead } : {}),
  };
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
