import { describe, expect, it } from 'vitest';
import { formatObservation } from '../src/domain/observation.js';
import type { ReplObservation } from '../src/domain/ports/repl.js';

function observation(overrides: Partial<ReplObservation> = {}): ReplObservation {
  return {
    ok: true,
    logs: [],
    value: undefined,
    error: undefined,
    finalAnswer: undefined,
    ...overrides,
  };
}

describe('formatObservation', () => {
  it('reports logs, value and error', () => {
    const text = formatObservation(
      observation({ logs: ['first', 'second'], value: '42', error: 'boom' }),
    );
    expect(text).toBe('first\nsecond\n=> 42\nERROR: boom');
  });

  it('says so when there is no output', () => {
    expect(formatObservation(observation())).toBe('(no output)');
  });
});
