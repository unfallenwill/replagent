import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileWorld } from '../src/adapters/world/file-world.js';
import { addFact, emptyWorld } from '../src/domain/world.js';

const directories: string[] = [];

function directory(): string {
  const created = mkdtempSync(path.join(tmpdir(), 'replagent-world-'));
  directories.push(created);
  return created;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('FileWorld', () => {
  it('has no model until one is written', () => {
    const world = new FileWorld(path.join(directory(), 'world.json'));

    expect(world.read()).toEqual(emptyWorld());
  });

  it('keeps the model where it was told to', () => {
    const file = path.join(directory(), 'nested', 'world.json');
    const world = new FileWorld(file);

    world.write(addFact(emptyWorld(), 'module count', 4, 'readdir src', 'now'));

    expect(world.path).toBe(path.resolve(file));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      facts: { 'module count': { value: 4, source: 'readdir src', at: 'now' } },
      beliefs: {},
      plan: undefined,
    });
  });

  it('survives the process that wrote it', () => {
    const file = path.join(directory(), 'world.json');
    const first = new FileWorld(file);
    first.write(addFact(emptyWorld(), 'module count', 4, 'readdir src', 'now'));

    const second = new FileWorld(file);

    expect(second.read().facts['module count']?.value).toBe(4);
  });

  it('starts over when the file is not a model', () => {
    const file = path.join(directory(), 'world.json');
    writeFileSync(file, 'not json at all', 'utf8');
    const world = new FileWorld(file);

    expect(world.read()).toEqual(emptyWorld());
  });

  it('drops the parts of a model that make no sense', () => {
    const file = path.join(directory(), 'world.json');
    writeFileSync(
      file,
      JSON.stringify({
        facts: { good: { value: 1, source: 'src', at: 'now' }, broken: { value: 2 } },
        beliefs: { wrong: { value: 1, source: 'src', at: 'now' } },
        plan: 42,
      }),
      'utf8',
    );
    const world = new FileWorld(file);

    const model = world.read();

    expect(Object.keys(model.facts)).toEqual(['good']);
    expect(model.beliefs).toEqual({});
    expect(model.plan).toBeUndefined();
  });
});
