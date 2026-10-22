import { describe, expect, it } from 'vitest';
import { addBelief, addFact, emptyWorld, formatWorld, setPlan } from '../src/domain/world.js';

describe('the world model', () => {
  it('starts empty', () => {
    const world = emptyWorld();

    expect(world.facts).toEqual({});
    expect(world.beliefs).toEqual({});
    expect(world.plan).toBeUndefined();
  });

  it('keeps a fact with its source and its time', () => {
    const world = addFact(emptyWorld(), 'module count', 4, 'readdir src', '2026-10-22T10:00:00Z');

    expect(world.facts['module count']).toEqual({
      value: 4,
      source: 'readdir src',
      at: '2026-10-22T10:00:00Z',
    });
  });

  it('replaces a fact when it is observed again', () => {
    const first = addFact(emptyWorld(), 'module count', 4, 'readdir src', '2026-10-22T10:00:00Z');
    const second = addFact(first, 'module count', 5, 'readdir src', '2026-10-22T10:05:00Z');

    expect(Object.keys(second.facts)).toEqual(['module count']);
    expect(second.facts['module count']?.value).toBe(5);
    expect(second.facts['module count']?.at).toBe('2026-10-22T10:05:00Z');
  });

  it('keeps facts and beliefs apart', () => {
    const world = addBelief(
      addFact(emptyWorld(), 'module count', 4, 'readdir src', '2026-10-22T10:00:00Z'),
      'the build is broken',
      true,
      0.6,
      'the tests failed',
      '2026-10-22T10:01:00Z',
    );

    expect(world.beliefs['the build is broken']).toEqual({
      value: true,
      source: 'the tests failed',
      at: '2026-10-22T10:01:00Z',
      confidence: 0.6,
    });
    expect(world.facts['the build is broken']).toBeUndefined();
  });

  it('clamps the confidence to a probability', () => {
    const tooSure = addBelief(emptyWorld(), 'x', 1, 4, 'why', 'now');
    const tooSure2 = addBelief(emptyWorld(), 'x', 1, -2, 'why', 'now');

    expect(tooSure.beliefs['x']?.confidence).toBe(1);
    expect(tooSure2.beliefs['x']?.confidence).toBe(0);
  });

  it('does not change the old model when it makes a new one', () => {
    const before = addFact(emptyWorld(), 'a', 1, 'src', 'now');
    const after = addFact(before, 'b', 2, 'src', 'now');

    expect(Object.keys(before.facts)).toEqual(['a']);
    expect(Object.keys(after.facts)).toEqual(['a', 'b']);
  });

  it('holds the plan', () => {
    const world = setPlan(emptyWorld(), { name: 'check the build', description: 'run the tests' });

    expect(world.plan).toEqual({ name: 'check the build', description: 'run the tests' });
  });
});

describe('formatWorld', () => {
  it('writes out an empty model', () => {
    expect(formatWorld(emptyWorld())).toBe('facts: none\nbeliefs: none\nplan: none');
  });

  it('writes out one line per thing', () => {
    const world = setPlan(
      addBelief(
        addFact(emptyWorld(), 'module count', 4, 'readdir src', '2026-10-22T10:00:00Z'),
        'the build is broken',
        true,
        0.6,
        'the tests failed',
        '2026-10-22T10:01:00Z',
      ),
      { name: 'check the build', description: 'run the tests' },
    );

    expect(formatWorld(world)).toBe(
      [
        'facts:',
        '  module count = 4 (readdir src, 2026-10-22T10:00:00Z)',
        'beliefs:',
        '  the build is broken = true, confidence 0.6 (the tests failed, 2026-10-22T10:01:00Z)',
        'plan: check the build - run the tests',
      ].join('\n'),
    );
  });

  it('writes a string value as it is', () => {
    const world = addFact(emptyWorld(), 'name', 'replagent', 'package.json', 'now');

    expect(formatWorld(world)).toContain('name = replagent (package.json, now)');
  });
});
