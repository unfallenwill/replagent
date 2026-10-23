import { describe, expect, it } from 'vitest';
import { contextWindowFor, DEFAULT_CONTEXT_WINDOW } from '../src/cli/context-window.js';

describe('contextWindowFor', () => {
  it('gives the models this project runs on a million tokens', () => {
    expect(contextWindowFor('MiniMax-M3.1-Flash', undefined)).toBe(1_000_000);
    expect(contextWindowFor('MiniMax-M3', undefined)).toBe(1_000_000);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(1_000_000);
  });

  it('knows the smaller models it might be pointed at', () => {
    expect(contextWindowFor('claude-sonnet-4-5', undefined)).toBe(200_000);
  });

  it('assumes an unknown model is in the same class as the default', () => {
    // The models this project is built for carry a million tokens, so an
    // unknown one is given the same room rather than no denominator at all.
    expect(contextWindowFor('glm-4.6', undefined)).toBe(1_000_000);
  });

  it('lets the human say otherwise', () => {
    expect(contextWindowFor('glm-4.6', 128_000)).toBe(128_000);
    expect(contextWindowFor('claude-sonnet-4-5', 1000)).toBe(1000);
  });
});
