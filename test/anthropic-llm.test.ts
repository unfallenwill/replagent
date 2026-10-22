import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicLlm } from '../src/adapters/anthropic/anthropic-llm.js';
import type { LlmRequest } from '../src/domain/ports/llm.js';

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

  it('ignores thinking deltas', async () => {
    const { client } = fakeClient([
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    ]);
    const llm = new AnthropicLlm({ client, model: 'test-model' });

    const texts: string[] = [];
    for await (const event of llm.stream(request, new AbortController().signal)) {
      if (event.type === 'text') {
        texts.push(event.text);
      }
    }

    expect(texts).toEqual(['ok']);
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
