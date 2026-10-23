import { Conversation } from './conversation.js';
import type { SessionEvent, SessionHeader, SessionSummary } from './ports/session.js';

/** How much of the first thing the human said fits in a listing. */
const SUMMARY_CHARS = 80;

/**
 * What the model is told when a session died mid-turn.
 *
 * It is appended as a user message because that is what it is - something
 * the model has to know before it acts again. Pretending the turn never
 * happened would invite it to repeat side effects that may already exist.
 */
export const INTERRUPTED_NOTE: string =
  '<observation>\nThe previous session ended while this turn was running. Its effects are unknown; check the world model before repeating it.\n</observation>';

/**
 * Rebuild the conversation the way it was.
 *
 * Replaying through `append` - rather than handing the messages over as a
 * list - reproduces the live merge of consecutive same-role turns, which is
 * what the model actually saw. Thinking blocks are replayed only when the
 * session was recorded against the same model: a signature is the issuing
 * provider's proof, not a portable credential.
 */
export function restoreConversation(
  events: readonly SessionEvent[],
  replayThinking: boolean,
): Conversation {
  const conversation = new Conversation();
  for (const event of events) {
    if (event.type !== 'message') {
      continue;
    }
    const thinking = replayThinking ? event.message.thinking : undefined;
    conversation.append(event.message.role, event.message.text, thinking);
  }
  return conversation;
}

/**
 * Whether the last turn has no end: the process died while it was running.
 *
 * A resume note already in the log means the interruption was explained on a
 * previous resume, so a second one (a resume that crashed before running a
 * turn) does not add the note again.
 */
export function isInterrupted(events: readonly SessionEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) {
      continue;
    }
    if (event.type === 'turn.end') {
      return false;
    }
    if (event.type === 'message' && event.origin === 'resume') {
      return false;
    }
    if (event.type === 'turn.start') {
      return true;
    }
  }
  return false;
}

/** The listing line for a session, from its header and events. */
export function summarise(
  header: SessionHeader,
  events: readonly SessionEvent[],
  updatedAt: string,
): SessionSummary {
  const firstUserText = events
    .filter(
      (event): event is Extract<SessionEvent, { type: 'message' }> =>
        event.type === 'message' && event.message.role === 'user' && event.origin === 'human',
    )
    .map((event) => event.message.text)
    .at(0);

  const title = events
    .filter((event): event is Extract<SessionEvent, { type: 'title' }> => event.type === 'title')
    .at(-1)?.text;

  return {
    id: header.id,
    startedAt: header.at,
    updatedAt,
    model: header.model,
    turns: events.filter((event) => event.type === 'turn.start').length,
    ...(firstUserText !== undefined ? { firstUserText: shorten(firstUserText) } : {}),
    ...(title !== undefined ? { title } : {}),
  };
}

/** One line, short enough for a list. */
function shorten(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  const trimmed = line.trim();
  return trimmed.length <= SUMMARY_CHARS ? trimmed : `${trimmed.slice(0, SUMMARY_CHARS - 1)}…`;
}
