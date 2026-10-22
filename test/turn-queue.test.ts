import { describe, expect, it } from 'vitest';
import { TurnQueue } from '../src/cli/turn-queue.js';

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('TurnQueue', () => {
  it('runs the messages in order', async () => {
    const seen: string[] = [];
    const queue = new TurnQueue(async (text) => {
      seen.push(text);
    });

    queue.push('first');
    queue.push('second');
    await tick(30);

    expect(seen).toEqual(['first', 'second']);
    expect(queue.pending).toBe(0);
  });

  it('does not run two turns at the same time', async () => {
    let running = 0;
    let maxConcurrent = 0;
    const queue = new TurnQueue(async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await tick(10);
      running -= 1;
    });

    queue.push('a');
    queue.push('b');
    queue.push('c');
    await tick(80);

    expect(maxConcurrent).toBe(1);
  });

  it('keeps draining after a turn fails', async () => {
    const seen: string[] = [];
    const errors: unknown[] = [];
    const queue = new TurnQueue(
      async (text) => {
        seen.push(text);
        if (text === 'boom') {
          throw new Error('boom');
        }
      },
      (error) => {
        errors.push(error);
      },
    );

    queue.push('boom');
    queue.push('after');
    await tick(30);

    expect(errors).toHaveLength(1);
    // The failure of one turn must not lose the messages behind it.
    expect(seen).toContain('after');
  });

  it('accepts messages that arrive while a turn is running', async () => {
    const seen: string[] = [];
    const queue = new TurnQueue(async (text) => {
      seen.push(text);
      await tick(20);
    });

    queue.push('first');
    await tick(5);
    queue.push('second');
    await tick(60);

    expect(seen).toEqual(['first', 'second']);
  });
});
