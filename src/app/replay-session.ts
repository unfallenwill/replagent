import type { SessionEvent } from '../domain/ports/session.js';
import type { UiPort } from '../domain/ports/ui.js';

/** What the transcript says about a turn the session found unfinished. */
const RESUMED_NOTE = 'This session was resumed after an interruption; the model was told.';

/**
 * Put a recorded session back on the screen.
 *
 * Only what the human saw is replayed. The queue and the messages are the
 * context, not the transcript: the model reads a labelled block, while the
 * transcript shows the step, the tools it used and what it said as separate
 * folds. That is why the log keeps both forms, and why this reads the
 * structured events rather than the message text.
 */
export function replaySession(events: readonly SessionEvent[], ui: UiPort): void {
  // Whether a step's fold is still open. The next reply has to open its own
  // fold, and the way to say that is to close the last one.
  let open = false;

  for (const event of events) {
    switch (event.type) {
      case 'message':
        open = replayMessage(event, ui, open);
        break;
      case 'queue':
        replayQueue(event, ui);
        break;
      case 'step':
        ui.emit({ type: 'step', name: event.name, description: event.description });
        open = true;
        break;
      case 'tool':
        ui.emit({
          type: 'tool',
          tool: event.tool,
          intent: event.intent,
          detail: event.detail,
        });
        break;
      case 'say':
        ui.emit({ type: 'say', text: event.text });
        break;
      case 'note':
        ui.emit({ type: 'status', text: event.text });
        break;
      default:
        // The turn boundaries and the title have nothing to draw.
        break;
    }
  }

  if (open) {
    ui.emit({ type: 'exec-done' });
  }
}

/** The model's own turn: its reasoning, and the program it wrote. */
function replayMessage(
  event: Extract<SessionEvent, { type: 'message' }>,
  ui: UiPort,
  open: boolean,
): boolean {
  const { message } = event;
  if (message.role === 'assistant') {
    if (open) {
      ui.emit({ type: 'exec-done' });
    }
    const thinking = (message.thinking ?? []).map((block) => block.text).join('\n\n');
    if (thinking.length > 0) {
      ui.emit({ type: 'agent-thinking', text: thinking });
    }
    if (message.text.length > 0) {
      ui.emit({ type: 'agent-code', text: message.text });
    }
    return message.text.length > 0;
  }
  if (event.origin === 'human') {
    ui.emit({ type: 'user-message', text: message.text });
    return open;
  }
  if (event.origin === 'resume') {
    ui.emit({ type: 'status', text: RESUMED_NOTE });
  }
  return open;
}

/**
 * What went into the request.
 *
 * The human's words are the human's, and are shown as such. An error the
 * runtime put in the queue is shown too: the model read it, and so should
 * the human. What the model deposited is its own conclusion, and stays its
 * own.
 */
function replayQueue(event: Extract<SessionEvent, { type: 'queue' }>, ui: UiPort): void {
  for (const entry of event.entries) {
    if (entry.origin === 'human') {
      ui.emit({ type: 'user-message', text: entry.text });
      continue;
    }
    if (entry.origin === 'error') {
      ui.emit({ type: 'repl-error', text: entry.text });
    }
  }
}
