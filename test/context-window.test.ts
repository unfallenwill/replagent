import { describe, expect, it } from 'vitest';
import { contextWindowFor } from '../src/cli/context-window.js';

describe('contextWindowFor', () => {
  it('knows the model the project ships with', () => {
    expect(contextWindowFor('claude-sonnet-4-5', undefined)).toBe(200_000);
  });

  it('does not invent a window for a model it does not know', () => {
    // A wrong denominator turns a comfortable session into a nearly full
    // one, so an unknown model gets no denominator at all.
    expect(contextWindowFor('glm-4.6', undefined)).toBeUndefined();
  });

  it('lets the human say otherwise', () => {
    expect(contextWindowFor('glm-4.6', 1_000_000)).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-4-5', 1000)).toBe(1000);
  });
});
