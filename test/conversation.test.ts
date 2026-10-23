import { describe, expect, it } from 'vitest';
import { Conversation } from '../src/domain/conversation.js';

describe('Conversation', () => {
  it('keeps alternating turns', () => {
    const conversation = new Conversation();
    conversation.append('user', 'hello');
    conversation.append('assistant', 'const a = 1;');
    conversation.append('user', '=> 1');

    expect(conversation.messages).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'const a = 1;' },
      { role: 'user', text: '=> 1' },
    ]);
  });

  it('merges consecutive turns of the same role', () => {
    const conversation = new Conversation();
    conversation.append('user', 'first');
    conversation.append('user', 'second');

    expect(conversation.messages).toEqual([{ role: 'user', text: 'first\n\nsecond' }]);
  });

  it('keeps the reasoning with the assistant turn it produced', () => {
    const conversation = new Conversation();
    conversation.append('user', 'hello');
    conversation.append('assistant', 'const a = 1;', [
      { text: 'one is the easiest', signature: 'sig-1' },
    ]);

    expect(conversation.messages).toEqual([
      { role: 'user', text: 'hello' },
      {
        role: 'assistant',
        text: 'const a = 1;',
        thinking: [{ text: 'one is the easiest', signature: 'sig-1' }],
      },
    ]);
  });

  it('merges the reasoning of two turns that become one', () => {
    const conversation = new Conversation();
    conversation.append('assistant', 'first', [{ text: 'thinking first' }]);
    conversation.append('assistant', 'second', [{ text: 'thinking second', signature: 'sig-2' }]);

    expect(conversation.messages).toEqual([
      {
        role: 'assistant',
        text: 'first\n\nsecond',
        thinking: [{ text: 'thinking first' }, { text: 'thinking second', signature: 'sig-2' }],
      },
    ]);
  });

  it('ignores empty text', () => {
    const conversation = new Conversation();
    conversation.append('user', '');
    expect(conversation.messages).toHaveLength(0);
  });

  it('resets', () => {
    const conversation = new Conversation();
    conversation.append('user', 'hello');
    conversation.reset();
    expect(conversation.messages).toHaveLength(0);
  });
});
