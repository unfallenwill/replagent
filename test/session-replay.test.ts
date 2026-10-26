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

const CODE = 'await step("read the repo", "see what is there", async () => {});';

describe('replaySession', () => {
  it('puts the turn back on the screen in the order it happened', () => {
    const ui = new RecordingUi();

    replaySession(
      [
        event({ type: 'turn.start' }),
        event({ type: 'queue', entries: [{ origin: 'human', text: 'what is here?' }] }),
        event({
          type: 'message',
          origin: 'assistant',
          message: {
            role: 'assistant',
            text: CODE,
            thinking: [{ text: 'look first', signature: 'sig' }],
          },
        }),
        event({ type: 'step', name: 'read the repo', description: 'see what is there' }),
        event({ type: 'tool', tool: 'read', intent: 'see it', detail: 'README.md' }),
        event({ type: 'say', text: 'three files' }),
        event({ type: 'turn.end', status: 'finished' }),
      ],
      ui,
    );

    expect(ui.events).toEqual([
      { type: 'user-message', text: 'what is here?' },
      { type: 'agent-thinking', text: 'look first' },
      { type: 'agent-code', text: CODE },
      { type: 'step', name: 'read the repo', description: 'see what is there' },
      { type: 'tool', tool: 'read', intent: 'see it', detail: 'README.md' },
      { type: 'say', text: 'three files' },
      { type: 'exec-done' },
    ]);
  });

  it('does not mistake what the model deposited for the human speaking', () => {
    const ui = new RecordingUi();

    replaySession(
      [event({ type: 'queue', entries: [{ origin: 'model', text: 'there are three' }] })],
      ui,
    );

    expect(ui.events).toEqual([]);
  });

  it('shows the error the runtime put in the queue', () => {
    const ui = new RecordingUi();

    replaySession(
      [event({ type: 'queue', entries: [{ origin: 'error', text: 'ENOENT: no such file' }] })],
      ui,
    );

    expect(ui.events).toEqual([{ type: 'repl-error', text: 'ENOENT: no such file' }]);
  });

  it('says when the session had been resumed', () => {
    const ui = new RecordingUi();

    replaySession(
      [
        event({
          type: 'message',
          origin: 'resume',
          message: { role: 'user', text: 'the previous turn was interrupted' },
        }),
      ],
      ui,
    );

    expect(ui.events).toHaveLength(1);
    expect(ui.events[0]?.type).toBe('status');
  });

  it('replays notes and what the agent said', () => {
    const ui = new RecordingUi();

    replaySession(
      [
        event({ type: 'note', text: 'Stopped: reached the limit of 24 steps.' }),
        event({ type: 'say', text: 'there are three files' }),
      ],
      ui,
    );

    expect(ui.events).toContainEqual({
      type: 'status',
      text: 'Stopped: reached the limit of 24 steps.',
    });
    expect(ui.events).toContainEqual({ type: 'say', text: 'there are three files' });
  });

  it('closes one reply before the next one opens', () => {
    const ui = new RecordingUi();

    replaySession(
      [
        event({
          type: 'message',
          origin: 'assistant',
          message: { role: 'assistant', text: 'first' },
        }),
        event({
          type: 'message',
          origin: 'assistant',
          message: { role: 'assistant', text: 'second' },
        }),
      ],
      ui,
    );

    expect(ui.events).toEqual([
      { type: 'agent-code', text: 'first' },
      { type: 'exec-done' },
      { type: 'agent-code', text: 'second' },
      { type: 'exec-done' },
    ]);
  });

  it('draws nothing for a turn that never said anything', () => {
    const ui = new RecordingUi();

    replaySession(
      [event({ type: 'turn.start' }), event({ type: 'turn.end', status: 'finished' })],
      ui,
    );

    expect(ui.events).toEqual([]);
  });
});
