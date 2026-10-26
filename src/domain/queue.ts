/**
 * The one channel between the agent and everything it cannot see.
 *
 * The agent lives in a REPL. What comes back to it - the results of what it
 * did, the errors it hit, and the human's own words - all arrive through
 * this queue, and there is no other way in.
 *
 * The queue is deliberately thin: a list of entries, each with an origin.
 * The origin is not decoration. It is the difference between "the human
 * asked me this" and "I concluded this a moment ago", and a model that
 * cannot tell those apart will start taking its own conclusions for
 * instructions. Keeping the origin in the runtime - rather than asking the
 * model to be careful about it - is what makes the distinction a fact
 * instead of a habit.
 */

/** Who put the entry in the queue. */
export type QueueOrigin = 'human' | 'model' | 'error';

export interface QueueEntry {
  readonly origin: QueueOrigin;
  readonly text: string;
}

/**
 * The labels the model reads.
 *
 * The model's own deposits are marked `you`, so a conclusion can never
 * impersonate the human. Errors are marked `error`, because a failure and
 * a finding are not the same kind of thing.
 */
const LABELS: Readonly<Record<QueueOrigin, string>> = {
  human: 'human',
  model: 'you',
  error: 'error',
};

/** The marker that separates the queue from the human's own turn. */
export const QUEUE_OPEN = '<queue>';
export const QUEUE_CLOSE = '</queue>';

/**
 * The queue itself.
 *
 * It is shared between the human's side and the agent's side: the human
 * types into it, the agent's program deposits into it, and the loop drains
 * it into the next request. Nothing else touches it.
 */
export class MessageQueue {
  #entries: QueueEntry[] = [];

  /** How many entries are waiting. */
  get size(): number {
    return this.#entries.length;
  }

  /** True when there is nothing waiting. */
  get empty(): boolean {
    return this.#entries.length === 0;
  }

  /**
   * Put something in the queue.
   *
   * Empty text is dropped: an entry with nothing in it would only make the
   * model read a blank line and wonder what it means.
   */
  push(origin: QueueOrigin, text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    this.#entries.push({ origin, text: trimmed });
  }

  /** Take everything that is waiting, and leave the queue empty. */
  drain(): readonly QueueEntry[] {
    const entries = this.#entries;
    this.#entries = [];
    return entries;
  }

  /** What is waiting, without taking it. */
  peek(): readonly QueueEntry[] {
    return [...this.#entries];
  }
}

/**
 * Turn the queue into the text the model reads.
 *
 * Every line carries its label, not just the first one of an entry. That
 * is what keeps a label honest: text the model read from a file, or a
 * command's output, cannot smuggle in a line that claims to be the human.
 */
export function formatQueue(entries: readonly QueueEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const label = LABELS[entry.origin];
    for (const line of entry.text.split('\n')) {
      lines.push(`[${label}] ${line}`);
    }
  }
  return `${QUEUE_OPEN}\n${lines.join('\n')}\n${QUEUE_CLOSE}`;
}
