import { describe, expect, it } from 'vitest';
import type {
  SessionEvent,
  SessionEventInput,
  SessionHeader,
} from '../src/domain/ports/session.js';
import {
  INTERRUPTED_NOTE,
  isInterrupted,
  restoreConversation,
  summarise,
} from '../src/domain/session.js';

let seq = 0;

function event(input: SessionEventInput): SessionEvent {
  seq += 1;
  return { ...input, seq, at: '2026-10-23T19:10:00.000Z' };
}

const header: SessionHeader = {
  v: 1,
  type: 'session',
  id: '20261023T191005Z-844430e2',
  at: '2026-10-23T19:10:05.120Z',
  cwd: '/repo',
  model: 'MiniMax-M3.1-Flash',
  effort: 'max',
  maxTokens: 131_072,
  maxSteps: 24,
  world: '.replagent/world.json',
  systemPromptHash: 'sha256:test',
  agent: 'replagent',
};

describe('restoreConversation', () => {
  it('rebuilds the turns, reasoning and all', () => {
    const events = [
      event({ type: 'message', origin: 'human', message: { role: 'user', text: 'hello' } }),
      event({
        type: 'message',
        origin: 'assistant',
        message: {
          role: 'assistant',
          text: '1;',
          thinking: [{ text: 'one is easiest', signature: 'sig' }],
        },
      }),
      event({
        type: 'message',
        origin: 'observation',
        message: { role: 'user', text: '<observation>\n1\n</observation>' },
      }),
    ];

    expect(restoreConversation(events, true).messages).toEqual([
      { role: 'user', text: 'hello' },
      {
        role: 'assistant',
        text: '1;',
        thinking: [{ text: 'one is easiest', signature: 'sig' }],
      },
      { role: 'user', text: '<observation>\n1\n</observation>' },
    ]);
  });

  it('merges consecutive same-role turns the way the live conversation did', () => {
    const events = [
      event({ type: 'message', origin: 'human', message: { role: 'user', text: 'one' } }),
      event({ type: 'message', origin: 'human', message: { role: 'user', text: 'two' } }),
    ];

    // Two appends, not one merged message in the file: the replay goes
    // through the same append, so the result is the same as it was live.
    expect(restoreConversation(events, true).messages).toEqual([
      { role: 'user', text: 'one\n\ntwo' },
    ]);
  });

  it('leaves the reasoning behind for a different model', () => {
    const events = [
      event({
        type: 'message',
        origin: 'assistant',
        message: {
          role: 'assistant',
          text: '1;',
          thinking: [{ text: 'a thought', signature: 'sig' }],
        },
      }),
    ];

    // A signature is the issuing provider's proof; showing the thought is
    // fine, sending it to another endpoint is not.
    expect(restoreConversation(events, false).messages).toEqual([
      { role: 'assistant', text: '1;' },
    ]);
  });

  it('includes a resume note the model was given', () => {
    const events = [
      event({ type: 'turn.start' }),
      event({
        type: 'message',
        origin: 'resume',
        message: { role: 'user', text: INTERRUPTED_NOTE },
      }),
    ];

    expect(restoreConversation(events, true).messages).toEqual([
      { role: 'user', text: INTERRUPTED_NOTE },
    ]);
  });
});

describe('isInterrupted', () => {
  it('is true when the last turn never ended', () => {
    expect(
      isInterrupted([
        event({ type: 'turn.start' }),
        event({ type: 'message', origin: 'human', message: { role: 'user', text: 'hi' } }),
      ]),
    ).toBe(true);
  });

  it('is false once the turn ended', () => {
    expect(
      isInterrupted([
        event({ type: 'turn.start' }),
        event({ type: 'turn.end', status: 'finished' }),
      ]),
    ).toBe(false);
  });

  it('is false when the interruption was already explained', () => {
    // A resume that crashed before running a turn must not add the note a
    // second time.
    expect(
      isInterrupted([
        event({ type: 'turn.start' }),
        event({
          type: 'message',
          origin: 'resume',
          message: { role: 'user', text: INTERRUPTED_NOTE },
        }),
      ]),
    ).toBe(false);
  });

  it('is false for an empty session', () => {
    expect(isInterrupted([])).toBe(false);
  });
});

describe('summarise', () => {
  it('counts turns and keeps the first thing the human said', () => {
    const summary = summarise(
      header,
      [
        event({ type: 'turn.start' }),
        event({ type: 'message', origin: 'human', message: { role: 'user', text: 'add a cache' } }),
        event({ type: 'turn.end', status: 'finished' }),
      ],
      '2026-10-23T19:20:00.000Z',
    );

    expect(summary).toMatchObject({
      id: header.id,
      model: header.model,
      startedAt: header.at,
      updatedAt: '2026-10-23T19:20:00.000Z',
      turns: 1,
      firstUserText: 'add a cache',
    });
  });

  it('does not mistake an observation for something the human said', () => {
    const summary = summarise(
      header,
      [
        event({
          type: 'message',
          origin: 'observation',
          message: { role: 'user', text: '<observation>\n1\n</observation>' },
        }),
        event({ type: 'message', origin: 'human', message: { role: 'user', text: 'really?' } }),
      ],
      header.at,
    );

    expect(summary.firstUserText).toBe('really?');
  });

  it('lets the last title win', () => {
    const summary = summarise(
      header,
      [event({ type: 'title', text: 'first name' }), event({ type: 'title', text: 'better name' })],
      header.at,
    );

    expect(summary.title).toBe('better name');
  });

  it('shortens a long first line', () => {
    const summary = summarise(
      header,
      [
        event({
          type: 'message',
          origin: 'human',
          message: { role: 'user', text: 'x'.repeat(200) },
        }),
      ],
      header.at,
    );

    expect(summary.firstUserText?.length).toBeLessThanOrEqual(80);
    expect(summary.firstUserText?.endsWith('…')).toBe(true);
  });
});
