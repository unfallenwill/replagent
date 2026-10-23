import type Anthropic from '@anthropic-ai/sdk';
import type {
  LlmMessage,
  LlmPort,
  LlmRequest,
  LlmStopReason,
  LlmStreamEvent,
  LlmThinkingBlock,
  LlmUsage,
  ReasoningEffort,
} from '../../domain/ports/llm.js';

type DoneEvent = Extract<LlmStreamEvent, { type: 'done' }>;

export interface AnthropicLlmOptions {
  readonly client: Anthropic;
  readonly model: string;
  /** How hard the model is asked to think; M3.1-Flash's ladder. */
  readonly effort?: ReasoningEffort;
}

/**
 * The Anthropic adapter.
 *
 * Note what is *not* here: no tool definitions. The agent has no tools, so
 * the request carries nothing but a system prompt and a conversation, and the
 * reply is JavaScript.
 *
 * Reasoning is different: it is not a tool, it is part of the reply. When the
 * model thought before it spoke, that block is carried back on the assistant
 * turn exactly as it arrived - text and signature - because interleaved
 * thinking is built on the model recognising its own thoughts.
 */
export class AnthropicLlm implements LlmPort {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #effort: ReasoningEffort;

  constructor(options: AnthropicLlmOptions) {
    this.#client = options.client;
    this.#model = options.model;
    this.#effort = options.effort ?? 'max';
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const stream = this.#client.messages.stream(
      {
        model: this.#model,
        max_tokens: request.maxTokens,
        system: request.system,
        ...reasoningParams(this.#model, this.#effort),
        messages: request.messages.map((message) => ({
          role: message.role,
          content: toContent(message),
        })),
      },
      { signal },
    );

    const tracker = new UsageTracker();
    const content = new ContentTracker();
    for await (const event of stream) {
      content.read(event);
      const delta = deltaOf(event);
      if (delta !== undefined) {
        yield delta;
        continue;
      }
      const done = tracker.read(event);
      if (done !== undefined) {
        yield withThinking(done, content.thinking());
      }
    }

    // A stream that ends without ever saying why still gets its `done`.
    const done = tracker.flush();
    if (done !== undefined) {
      yield withThinking(done, content.thinking());
    }
  }
}

/**
 * The thinking knobs MiniMax understands, for the models that take them.
 *
 * M3.1-Flash thinks always and is asked how hard; M3 thinks only when told
 * to, so it gets the switch without the ladder. Other endpoints - Claude, a
 * gateway - are left exactly as they were.
 */
function reasoningParams(model: string, effort: ReasoningEffort): ReasoningParams {
  if (!model.startsWith('MiniMax-M3')) {
    return {};
  }
  return {
    thinking: { type: 'adaptive' },
    ...(model.startsWith('MiniMax-M3.1') ? { output_config: { effort } } : {}),
  };
}

interface ReasoningParams {
  readonly thinking?: { readonly type: 'adaptive' };
  readonly output_config?: { readonly effort: ReasoningEffort };
}

/**
 * The message as the API wants it: plain text unless there was reasoning, in
 * which case the turn is the thinking blocks followed by the text they led
 * to. The signature goes back untouched. A provider that signed nothing gets
 * an empty signature, which is the only value the typed API will accept for
 * a field it never filled.
 */
function toContent(message: LlmMessage): Anthropic.Messages.MessageParam['content'] {
  if (
    message.role !== 'assistant' ||
    message.thinking === undefined ||
    message.thinking.length === 0
  ) {
    return message.text;
  }
  const blocks: Anthropic.Messages.ContentBlockParam[] = message.thinking.map((block) => ({
    type: 'thinking',
    thinking: block.text,
    signature: block.signature ?? '',
  }));
  if (message.text.length > 0) {
    blocks.push({ type: 'text', text: message.text });
  }
  return blocks;
}

function withThinking(done: DoneEvent, thinking: readonly LlmThinkingBlock[]): DoneEvent {
  return thinking.length > 0 ? { ...done, thinking } : done;
}

/**
 * What a delta adds, when it adds anything. Empty deltas - and the deltas
 * that carry no text at all, which some gateways send - are not events: the
 * tracker has already folded them, and the UI has nothing to draw.
 */
function deltaOf(event: Anthropic.Messages.RawMessageStreamEvent): LlmStreamEvent | undefined {
  if (event.type !== 'content_block_delta') {
    return undefined;
  }
  const delta = event.delta;
  if (delta.type === 'text_delta') {
    const text = textOf(delta.text);
    return text.length > 0 ? { type: 'text', text } : undefined;
  }
  if (delta.type === 'thinking_delta') {
    const thinking = textOf(delta.thinking);
    return thinking.length > 0 ? { type: 'thinking', text: thinking } : undefined;
  }
  return undefined;
}

/**
 * A string field as the wire sent it. The protocol says these are strings;
 * gateways omit them, and an omitted field must read as empty, not throw.
 */
function textOf(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

/**
 * The content blocks of one stream, folded back into their order.
 *
 * A reply is more than its text. The reasoning arrives as its own block, and
 * the API expects that block back on the next request - whole, in place, with
 * the signature it was issued. Deltas are keyed by block index; a signature
 * delta replaces the block's signature, because the API sends it complete.
 */
class ContentTracker {
  readonly #blocks = new Map<number, TrackedBlock>();

  /** Fold one upstream event. Text and thinking deltas both land in a block. */
  read(event: Anthropic.Messages.RawMessageStreamEvent): void {
    if (event.type === 'content_block_start') {
      this.#start(event);
      return;
    }
    if (event.type === 'content_block_delta') {
      this.#delta(event);
    }
  }

  #start(event: Anthropic.Messages.RawContentBlockStartEvent): void {
    const block = event.content_block;
    // A gateway is free to open a block with the fields the protocol
    // describes left out. Opening happens before anything is known about the
    // block, so an absent field is an empty one here, not a reason to lose
    // the session: the deltas that follow carry the content.
    if (block.type === 'thinking') {
      const signature = textOf(block.signature);
      this.#blocks.set(event.index, {
        kind: 'thinking',
        text: textOf(block.thinking),
        ...(signature.length > 0 ? { signature } : {}),
      });
      return;
    }
    if (block.type === 'text') {
      this.#blocks.set(event.index, { kind: 'text', text: textOf(block.text) });
    }
  }

  #delta(event: Anthropic.Messages.RawContentBlockDeltaEvent): void {
    const delta = event.delta;
    if (delta.type === 'text_delta') {
      this.#block(event.index, 'text').text += textOf(delta.text);
      return;
    }
    if (delta.type === 'thinking_delta') {
      this.#block(event.index, 'thinking').text += textOf(delta.thinking);
      return;
    }
    if (delta.type === 'signature_delta') {
      // A signature belongs to a block that already exists; a lone one is not
      // a thought and must not invent one.
      const signature = textOf(delta.signature);
      const block = this.#blocks.get(event.index);
      if (signature.length > 0 && block !== undefined && block.kind === 'thinking') {
        block.signature = signature;
      }
    }
  }

  /** The reasoning blocks, in the order the model produced them. */
  thinking(): readonly LlmThinkingBlock[] {
    return [...this.#blocks.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([, block]) =>
        block.kind === 'thinking' && block.text.length > 0
          ? [
              {
                text: block.text,
                ...(block.signature !== undefined ? { signature: block.signature } : {}),
              },
            ]
          : [],
      );
  }

  #block(index: number, kind: TrackedBlock['kind']): TrackedBlock {
    const existing = this.#blocks.get(index);
    if (existing !== undefined) {
      return existing;
    }
    const created: TrackedBlock = { kind, text: '' };
    this.#blocks.set(index, created);
    return created;
  }
}

interface TrackedBlock {
  readonly kind: 'thinking' | 'text';
  text: string;
  signature?: string;
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
  read(event: Anthropic.Messages.RawMessageStreamEvent): DoneEvent | undefined {
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
  flush(): DoneEvent | undefined {
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
