import { describe, expect, it } from 'vitest';
import { replaySession } from '../src/app/replay-session.js';
import type { SessionEvent, SessionEventInput } from '../src/domain/ports/session.js';
import type { UiEvent, UiPort } from '../src/domain/ports/ui.js';

class RecordingUi implements UiPort {
  readonly events: UiEvent[] = [];

  emit(event: UiEvent): void {
    this.events.push(event);
  }

  onInput(): void {
    // not used in these tests
  }

  async run(): Promise<void> {
    // not used in these tests
  }

  stop(): void {
    // not used in these tests
  }
}

let seq = 0;

function event(input: SessionEventInput): SessionEvent {
  seq += 1;
  return { ...input, seq, at: '2026-10-23T19:10:00.000Z' };
}

const observation = {
  ok: true,
  logs: ['three files'],
  value: 'undefined',
  error: undefined,
  finalAnswer: undefined,
  step: { name: 'read the repo', description: 'see what is there' },
};

describe('replaySession', () => {
  it('puts the turn back on the screen in the order it happened', () => {
    const ui = new RecordingUi();

    replaySession(
      [
        event({ type: 'turn.start' }),
        event({
          type: 'message',
          origin: 'human',
          message: { role: 'user', text: 'what is here?' },
        }),
        event({
          type: 'message',
          origin: 'assistant',
          message: {
            role: 'assistant',
            text: 'await step("read the repo", "see what is there", async () => {});',
            thinking: [{ text: 'look first', signature: 'sig' }],
          },
        }),
        event({ type: 'observation', observation }),
        event({
          type: 'message',
          origin: 'observation',
          message: { role: 'user', text: '<observation>\nthree files\n</observation>' },
        }),
        event({ type: 'turn.end', status: 'finished' }),
      ],
      ui,
    );

    expect(ui.events).toEqual([
      { type: 'user-message', text: 'what is here?' },
      { type: 'agent-thinking', text: 'look first' },
      {
        type: 'agent-code',
        text: 'await step("read the repo", "see what is there", async () => {});',
      },
      { type: 'step', name: 'read the repo', description: 'see what is there' },
      { type: 'exec-done' },
      { type: 'repl-log', text: 'three files' },
      { type: 'repl-value', text: 'undefined' },
    ]);
  });

  it('does not mistake the observation the model read for the human speaking', () => {
    const ui = new RecordingUi();

    replaySession(
      [
        event({
          type: 'message',
          origin: 'observation',
          message: { role: 'user', text: '<observation>\n1\n</observation>' },
        }),
      ],
      ui,
    );

    expect(ui.events).toEqual([]);
  });

  it('says when the session had been resumed', () => {
    const ui = new RecordingUi();

    replaySession(
      [
        event({
          type: 'message',
          origin: 'resume',
          message: { role: 'user', text: '<observation>interrupted</observation>' },
        }),
      ],
      ui,
    );

    expect(ui.events).toHaveLength(1);
    expect(ui.events[0]?.type).toBe('status');
  });

  it('replays notes and the final answer', () => {
    const ui = new RecordingUi();

    replaySession(
      [
        event({ type: 'note', text: 'The reply was cut off (max_tokens reached).' }),
        event({
          type: 'observation',
          observation: { ...observation, finalAnswer: 'done' },
        }),
      ],
      ui,
    );

    expect(ui.events).toContainEqual({
      type: 'status',
      text: 'The reply was cut off (max_tokens reached).',
    });
    expect(ui.events).toContainEqual({ type: 'final', text: 'done' });
  });

  it('survives an observation with holes in it', () => {
    const ui = new RecordingUi();

    replaySession(
      [
        event({
          type: 'observation',
          observation: { ok: false } as unknown as typeof observation,
        }),
      ],
      ui,
    );

    // A damaged display event costs a fold, not the session.
    expect(ui.events).toContainEqual({ type: 'exec-done' });
  });
});
