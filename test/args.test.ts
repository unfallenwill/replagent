import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_URL,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_WORLD_PATH,
  parseArgs,
} from '../src/cli/args.js';

describe('parseArgs', () => {
  it('uses the defaults', () => {
    const options = parseArgs([], {});
    expect(options.model).toBe(DEFAULT_MODEL);
    expect(options.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(options.maxTokens).toBe(131_072);
    expect(options.maxSteps).toBe(24);
    expect(options.effort).toBe(DEFAULT_EFFORT);
    expect(options.contextWindow).toBeUndefined();
    expect(options.world).toBe(DEFAULT_WORLD_PATH);
  });

  it('reads the thinking effort', () => {
    expect(parseArgs(['--effort', 'low'], {}).effort).toBe('low');
    expect(parseArgs(['--effort', 'xhigh'], {}).effort).toBe('xhigh');
  });

  it('rejects an effort the model does not have', () => {
    // M3.1-Flash has no `none` rung: it rejects the word outright.
    expect(() => parseArgs(['--effort', 'none'], {})).toThrow(
      '--effort must be one of low, medium, high, xhigh, max',
    );
  });

  it('reads the context window', () => {
    const options = parseArgs(['--context-window', '1000000'], {});

    expect(options.contextWindow).toBe(1_000_000);
  });

  it('reads where to keep the world model', () => {
    const options = parseArgs(['--world', 'notes/model.json'], {});

    expect(options.world).toBe('notes/model.json');
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
