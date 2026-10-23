import type { ReplObservation } from '../domain/ports/repl.js';
import type { SessionEvent } from '../domain/ports/session.js';
import type { UiPort } from '../domain/ports/ui.js';

/** What the transcript says about a turn the session found unfinished. */
const RESUMED_NOTE = 'This session was resumed after an interruption; the model was told.';

/**
 * Put a recorded session back on the screen.
 *
 * Only what the human saw is replayed. The messages are the context, not the
 * transcript: the observation the model reads is a formatted block, while the
 * transcript shows the step, its logs and its value as separate folds. That
 * is why the log keeps both forms, and why this reads the structured events
 * rather than the message text.
 */
export function replaySession(events: readonly SessionEvent[], ui: UiPort): void {
  for (const event of events) {
    if (event.type === 'message') {
      replayMessage(event, ui);
    } else if (event.type === 'observation') {
      replayObservation(event.observation, ui);
    } else if (event.type === 'note') {
      ui.emit({ type: 'status', text: event.text });
    }
  }
}

function replayMessage(event: Extract<SessionEvent, { type: 'message' }>, ui: UiPort): void {
  const { message } = event;
  if (message.role === 'assistant') {
    const thinking = (message.thinking ?? []).map((block) => block.text).join('\n\n');
    if (thinking.length > 0) {
      ui.emit({ type: 'agent-thinking', text: thinking });
    }
    if (message.text.length > 0) {
      ui.emit({ type: 'agent-code', text: message.text });
    }
    return;
  }
  if (event.origin === 'human') {
    ui.emit({ type: 'user-message', text: message.text });
    return;
  }
  if (event.origin === 'resume') {
    ui.emit({ type: 'status', text: RESUMED_NOTE });
  }
}

function replayObservation(observation: ReplObservation, ui: UiPort): void {
  if (observation.step !== undefined) {
    ui.emit({
      type: 'step',
      name: observation.step.name,
      description: observation.step.description,
    });
  }
  ui.emit({ type: 'exec-done' });
  const logs = Array.isArray(observation.logs) ? observation.logs : [];
  for (const log of logs) {
    ui.emit({ type: 'repl-log', text: log });
  }
  if (typeof observation.value === 'string') {
    ui.emit({ type: 'repl-value', text: observation.value });
  }
  if (typeof observation.error === 'string') {
    ui.emit({ type: 'repl-error', text: observation.error });
  }
  if (typeof observation.finalAnswer === 'string') {
    ui.emit({ type: 'final', text: observation.finalAnswer });
  }
}
