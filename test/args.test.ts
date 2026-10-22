import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, parseArgs } from '../src/cli/args.js';

describe('parseArgs', () => {
  it('uses the defaults', () => {
    const options = parseArgs([], {});
    expect(options.model).toBe(DEFAULT_MODEL);
    expect(options.baseUrl).toBeUndefined();
    expect(options.maxTokens).toBe(8192);
    expect(options.maxSteps).toBe(24);
  });

  it('reads the model and base url from the environment', () => {
    const options = parseArgs([], {
      ANTHROPIC_MODEL: 'glm-4.6',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
    });
    expect(options.model).toBe('glm-4.6');
    expect(options.baseUrl).toBe('https://gateway.example.com');
  });

  it('prefers flags over the environment', () => {
    const options = parseArgs(
      ['--model', 'claude-opus-4-1', '--base-url', 'https://flag.example.com'],
      { ANTHROPIC_MODEL: 'glm-4.6', ANTHROPIC_BASE_URL: 'https://env.example.com' },
    );
    expect(options.model).toBe('claude-opus-4-1');
    expect(options.baseUrl).toBe('https://flag.example.com');
  });

  it('rejects unknown arguments', () => {
    expect(() => parseArgs(['--nope'], {})).toThrow('Unknown argument: --nope');
  });

  it('rejects a flag without a value', () => {
    expect(() => parseArgs(['--model'], {})).toThrow('--model requires a value');
  });

  it('rejects a non numeric limit', () => {
    expect(() => parseArgs(['--max-steps', 'lots'], {})).toThrow(
      '--max-steps requires a positive integer',
    );
  });
});
