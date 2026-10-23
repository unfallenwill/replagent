import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicLlm } from '../src/adapters/anthropic/anthropic-llm.js';
import type { LlmRequest, LlmStreamEvent } from '../src/domain/ports/llm.js';

interface StreamCall {
  readonly body: unknown;
  readonly options: unknown;
}

function fakeClient(events: readonly unknown[]): { client: Anthropic; calls: StreamCall[] } {
  const calls: StreamCall[] = [];
  const client = {
    messages: {
      stream: (body: unknown, options: unknown) => {
        calls.push({ body, options });
        return {
          async *[Symbol.asyncIterator]() {
            for (const event of events) {
              yield event;
            }
          },
        };
      },
    },
  } as unknown as Anthropic;

  return { client, calls };
}

const request: LlmRequest = {
  system: 'you speak javascript',
  messages: [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'console.log(1)' },
  ],
  maxTokens: 512,
};

type DoneEvent = Extract<LlmStreamEvent, { type: 'done' }>;

/** Run one stream to completion and return its `done` event, if any. */
async function drainDone(llm: AnthropicLlm): Promise<DoneEvent | undefined> {
  for await (const event of llm.stream(request, new AbortController().signal)) {
    if (event.type === 'done') {
      return event;
    }
  }
  return undefined;
}

describe('AnthropicLlm', () => {
  it('streams text deltas', async () => {
    const { client } = fakeClient([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'const a = ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '1;' } },
    ]);
    const llm = new AnthropicLlm({ client, model: 'test-model' });

    const texts: string[] = [];
    for await (const event of llm.stream(request, new AbortController().signal)) {
      if (event.type === 'text') {
        texts.push(event.text);
      }
    }

    expect(texts.join('')).toBe('const a = 1;');
  });

  it('streams thinking deltas as reasoning, before the code', async () => {
    const { client } = fakeClient([
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    ]);
    const llm = new AnthropicLlm({ client, model: 'test-model' });

    const events: string[] = [];
    for await (const event of llm.stream(request, new AbortController().signal)) {
      if (event.type === 'thinking') {
        events.push(`thinking: ${event.text}`);
      } else if (event.type === 'text') {
        events.push(`text: ${event.text}`);
      }
    }

    // The reasoning is not dropped: it reaches the UI, in the order it
    // happened.
    expect(events).toEqual(['thinking: hmm', 'text: ok']);
  });

  it('ignores a thinking signature delta', async () => {
    const { client } = fakeClient([
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'abc' },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    ]);
    const llm = new AnthropicLlm({ client, model: 'test-model' });

    const events: string[] = [];
    for await (const event of llm.stream(request, new AbortController().signal)) {
      events.push(event.type);
    }

    expect(events).toEqual(['text', 'done']);
  });

  it('reports the stop reason', async () => {
    const { client } = fakeClient([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]);
    const llm = new AnthropicLlm({ client, model: 'test-model' });

    const reasons: string[] = [];
    for await (const event of llm.stream(request, new AbortController().signal)) {
      if (event.type === 'done') {
        reasons.push(event.stopReason);
      }
    }

    expect(reasons).toEqual(['end_turn']);
  });

  it('reports what the call cost, with the cache split', async () => {
    const { client } = fakeClient([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            cache_read_input_tokens: 400,
            cache_creation_input_tokens: 20,
          },
        },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '1;' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
    ]);
    const llm = new AnthropicLlm({ client, model: 'test-model' });

    const usages: unknown[] = [];
    for await (const event of llm.stream(request, new AbortController().signal)) {
      if (event.type === 'done' && event.usage !== undefined) {
        usages.push(event.usage);
      }
    }

    // The input counts cache traffic: those tokens are in the conversation
    // whether they were billed at full price or not.
    expect(usages).toEqual([{ input: 520, output: 42, cached: 400 }]);
  });

  it('reads the prompt from the stop event when the start carries zeroes', async () => {
    // Some gateways open the message with empty counters and only report
    // the real totals alongside the stop reason. The counters are
    // cumulative, so the last value wins.
    const { client } = fakeClient([
      {
        type: 'message_start',
        message: { usage: { input_tokens: 0, output_tokens: 0 } },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '1;' } },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          input_tokens: 100,
          output_tokens: 42,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 20,
        },
      },
    ]);
    const llm = new AnthropicLlm({ client, model: 'test-model' });

    const done = await drainDone(llm);

    expect(done?.usage).toEqual({ input: 520, output: 42, cached: 400 });
  });

  it('reports no usage when the endpoint accounts for no prompt at all', async () => {
    // A run of zeroes is not an empty prompt: it is an endpoint that did
    // not say what the prompt weighed, and the bar must not claim 0.
    const { client } = fakeClient([
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 0, output_tokens: 42 },
      },
    ]);
    const llm = new AnthropicLlm({ client, model: 'test-model' });

    const done = await drainDone(llm);

    expect(done !== undefined && 'usage' in done).toBe(false);
  });

  it('omits the cache count when the API reports no cache accounting', async () => {
    const { client } = fakeClient([
      { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
    ]);
    const llm = new AnthropicLlm({ client, model: 'test-model' });

    const done = await drainDone(llm);

    // An endpoint that never caches must not be read as one with a zero
    // percent hit rate.
    expect(done?.usage).toEqual({ input: 100, output: 42 });
    expect(done?.usage !== undefined && 'cached' in done.usage).toBe(false);
  });

  it('reports no usage when the stream never says what it cost', async () => {
    const { client } = fakeClient([
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
    ]);
    const llm = new AnthropicLlm({ client, model: 'test-model' });

    const done = await drainDone(llm);

    expect(done !== undefined && 'usage' in done).toBe(false);
  });

  it('reports a stop reason even when the stream does not send one', async () => {
    const { client } = fakeClient([]);
    const llm = new AnthropicLlm({ client, model: 'test-model' });

    const reasons: string[] = [];
    for await (const event of llm.stream(request, new AbortController().signal)) {
      if (event.type === 'done') {
        reasons.push(event.stopReason);
      }
    }

    expect(reasons).toEqual(['other']);
  });

  it('carries the reasoning of the reply back, signature and all', async () => {
    const { client } = fakeClient([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'one is easiest' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '1;' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    ]);
    const llm = new AnthropicLlm({ client, model: 'test-model' });

    const done = await drainDone(llm);

    // The thought is not just shown: it is handed over with the turn, so the
    // next request can send it back untouched.
    expect(done?.thinking).toEqual([{ text: 'one is easiest', signature: 'sig' }]);
  });

  it('does not invent a thought from a lone signature', async () => {
    const { client } = fakeClient([
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig' },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '1;' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]);
    const llm = new AnthropicLlm({ client, model: 'test-model' });

    const done = await drainDone(llm);

    expect(done?.thinking).toBeUndefined();
  });

  it('sends the reasoning back ahead of the text it produced', async () => {
    const { client, calls } = fakeClient([]);
    const llm = new AnthropicLlm({ client, model: 'test-model' });
    const withThinking: LlmRequest = {
      ...request,
      messages: [
        { role: 'user', text: 'hello' },
        {
          role: 'assistant',
          text: 'console.log(1)',
          thinking: [
            { text: 'start with one', signature: 'sig-a' },
            { text: 'then log it', signature: 'sig-b' },
          ],
        },
      ],
    };

    for await (const _event of llm.stream(withThinking, new AbortController().signal)) {
      // drain
    }

    expect(calls[0]?.body).toMatchObject({
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'start with one', signature: 'sig-a' },
            { type: 'thinking', thinking: 'then log it', signature: 'sig-b' },
            { type: 'text', text: 'console.log(1)' },
          ],
        },
      ],
    });
  });

  it('asks M3.1-Flash to think adaptively, at the chosen effort', async () => {
    const { client, calls } = fakeClient([]);
    const llm = new AnthropicLlm({ client, model: 'MiniMax-M3.1-Flash', effort: 'high' });

    for await (const _event of llm.stream(request, new AbortController().signal)) {
      // drain
    }

    expect(calls[0]?.body).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
  });

  it('leaves the effort off a model that has no ladder for it', async () => {
    const { client, calls } = fakeClient([]);
    const llm = new AnthropicLlm({ client, model: 'MiniMax-M3', effort: 'high' });

    for await (const _event of llm.stream(request, new AbortController().signal)) {
      // drain
    }

    // M3 thinks when told to, but does not grade how hard.
    expect(calls[0]?.body).toMatchObject({ thinking: { type: 'adaptive' } });
    expect(calls[0]?.body).not.toHaveProperty('output_config');
  });

  it('sends no thinking knobs to an endpoint that is not MiniMax', async () => {
    const { client, calls } = fakeClient([]);
    const llm = new AnthropicLlm({ client, model: 'claude-sonnet-4-5' });

    for await (const _event of llm.stream(request, new AbortController().signal)) {
      // drain
    }

    expect(calls[0]?.body).not.toHaveProperty('thinking');
    expect(calls[0]?.body).not.toHaveProperty('output_config');
  });

  it('sends the conversation and the system prompt, and no tools', async () => {
    const { client, calls } = fakeClient([]);
    const llm = new AnthropicLlm({ client, model: 'test-model' });
    const signal = new AbortController().signal;

    for await (const _event of llm.stream(request, signal)) {
      // drain
    }

    const call = calls[0];
    expect(call?.body).toEqual({
      model: 'test-model',
      max_tokens: 512,
      system: 'you speak javascript',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'console.log(1)' },
      ],
    });
    expect(call?.body).not.toHaveProperty('tools');
    expect(call?.options).toEqual({ signal });
  });
});
