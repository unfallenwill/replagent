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
    mismatch: undefined,
    step: undefined,
    ...overrides,
  };
}

describe('formatObservation', () => {
  it('reports logs, value and error', () => {
    const text = formatObservation(
      observation({ logs: ['first', 'second'], value: '42', error: 'boom' }),
    );
    expect(text).toBe('<observation>\nfirst\nsecond\n=> 42\nERROR: boom\n</observation>');
  });

  it('reports a mismatch between the prediction and the result', () => {
    const text = formatObservation(
      observation({ value: '5', mismatch: 'MISMATCH: expected 3, got 5' }),
    );
    expect(text).toBe('<observation>\n=> 5\nMISMATCH: expected 3, got 5\n</observation>');
  });

  it('says so when there is no output', () => {
    expect(formatObservation(observation())).toBe('<observation>\n(no output)\n</observation>');
  });

  it('marks the observation so it cannot be mistaken for the human', () => {
    const text = formatObservation(observation({ logs: ['hello'] }));
    expect(text.startsWith('<observation>')).toBe(true);
    expect(text.endsWith('</observation>')).toBe(true);
  });
});
