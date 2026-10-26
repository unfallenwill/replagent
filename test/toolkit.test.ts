import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createToolkit } from '../src/adapters/toolkit/index.js';
import type { ToolAction } from '../src/adapters/toolkit/toolkit.js';

let workspace = '';
let actions: ToolAction[] = [];

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'replagent-toolkit-'));
  actions = [];
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function toolkit() {
  return createToolkit({
    cwd: workspace,
    onAction: (action) => {
      actions.push(action);
    },
  });
}

describe('read', () => {
  it('reads a file', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'one\ntwo\nthree', 'utf8');
    const text = await toolkit().read('a.txt', 'see what is in it');
    expect(text).toBe('one\ntwo\nthree');
  });

  it('says what it did and why', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'one\ntwo', 'utf8');
    await toolkit().read('a.txt', 'see what is in it');
    expect(actions[0]?.tool).toBe('read a.txt');
    expect(actions[0]?.intent).toBe('see what is in it');
    expect(actions[0]?.detail).toBe('2 lines');
  });

  it('reads a range of lines', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'one\ntwo\nthree\nfour', 'utf8');
    const text = await toolkit().read('a.txt', 'read the middle', { from: 2, to: 3 });
    expect(text).toBe('two\nthree');
  });

  it('refuses to run without an intent', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'one', 'utf8');
    await expect(toolkit().read('a.txt', '')).rejects.toThrow(/needs to know why/);
  });

  it('says so when the file is not there', async () => {
    await expect(toolkit().read('missing.txt', 'look for it')).rejects.toThrow(/could not read/);
  });
});

describe('ls', () => {
  it('lists a directory and marks the directories', async () => {
    await writeFile(path.join(workspace, 'b.txt'), '', 'utf8');
    await toolkit().ls('.', 'see the layout');
    expect(actions[0]?.tool).toBe('ls .');
    expect(actions[0]?.detail).toBe('1 entries');
  });

  it('refuses to run without an intent', async () => {
    await expect(toolkit().ls('.', '   ')).rejects.toThrow(/needs to know why/);
  });
});

describe('glob', () => {
  it('finds the files that match', async () => {
    await writeFile(path.join(workspace, 'one.ts'), '', 'utf8');
    await writeFile(path.join(workspace, 'two.md'), '', 'utf8');
    const found = await toolkit().glob('*.ts', 'find the typescript');
    expect(found).toEqual(['one.ts']);
  });

  it('leaves out node_modules', async () => {
    await writeFile(path.join(workspace, 'node_modules', 'x.js'), '', 'utf8').catch(
      () => undefined,
    );
    const found = await toolkit().glob('**/*.js', 'find the javascript');
    expect(found).toEqual([]);
  });

  it('refuses to run without an intent', async () => {
    await expect(toolkit().glob('*', '')).rejects.toThrow(/needs to know why/);
  });
});

describe('edit', () => {
  it('replaces text that appears once', async () => {
    const file = path.join(workspace, 'a.txt');
    await writeFile(file, 'one\ntwo\nthree\n', 'utf8');

    const result = await toolkit().edit('a.txt', 'fix the number', {
      old: 'two',
      new: 'TWO',
    });

    expect(await readFile(file, 'utf8')).toBe('one\nTWO\nthree\n');
    expect(result.from).toBe(2);
    expect(result.to).toBe(2);
    expect(result.expanded).toBe(0);
  });

  it('grows the match until only one place is left', async () => {
    const file = path.join(workspace, 'a.txt');
    // The first two targets sit in exactly the same surroundings; the third
    // does not, so widening the match finds it.
    await writeFile(
      file,
      [
        'A',
        'B',
        'TARGET',
        'B',
        'A',
        '',
        'A',
        'B',
        'TARGET',
        'B',
        'A',
        '',
        'A',
        'B',
        'TARGET',
        'B',
        'C',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await toolkit().edit('a.txt', 'change the third one', {
      old: 'TARGET',
      new: 'CHANGED',
    });

    const text = await readFile(file, 'utf8');
    expect(text.split('\n').filter((line) => line === 'CHANGED')).toHaveLength(1);
    expect(text.split('\n')[14]).toBe('CHANGED');
    expect(result.from).toBe(15);
    expect(result.expanded).toBeGreaterThan(0);
  });

  it('refuses to guess when the text is genuinely ambiguous', async () => {
    const file = path.join(workspace, 'a.txt');
    await writeFile(file, 'A\nTARGET\nB\nC\nD\nE\nTARGET\nF\nG\nH\nI\nTARGET\nJ\nK\nL\n', 'utf8');

    await expect(
      toolkit().edit('a.txt', 'change one of them', { old: 'TARGET', new: 'CHANGED' }),
    ).rejects.toThrow(/could not tell which of the 3 places/);
  });

  it('leaves the file alone when it refuses', async () => {
    const file = path.join(workspace, 'a.txt');
    const before = 'A\nTARGET\nB\nC\nD\nE\nTARGET\nF\nG\nH\nI\nTARGET\nJ\nK\nL\n';
    await writeFile(file, before, 'utf8');

    await expect(
      toolkit().edit('a.txt', 'change one of them', { old: 'TARGET', new: 'CHANGED' }),
    ).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('says so when the text is not there', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'one\n', 'utf8');
    await expect(toolkit().edit('a.txt', 'change it', { old: 'nope', new: 'x' })).rejects.toThrow(
      /could not find/,
    );
  });

  it('needs the change as an object', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'one\n', 'utf8');
    await expect(toolkit().edit('a.txt', 'change it', 'one' as never)).rejects.toThrow(
      /needs the change as one object/,
    );
  });

  it('refuses to run without an intent', async () => {
    await expect(toolkit().edit('a.txt', '', { old: 'a', new: 'b' })).rejects.toThrow(
      /needs to know why/,
    );
  });
});

describe('bash', () => {
  it('runs a command and reports how it ended', async () => {
    const result = await toolkit().bash('node -e "console.log(1)"', 'check the runtime');
    expect(result.stdout.trim()).toBe('1');
    expect(result.code).toBe(0);
    expect(actions[0]?.tool).toBe('bash node -e "console.log(1)"');
    expect(actions[0]?.detail).toBe('exit 0 · 1 lines');
  });

  it('reports a command that failed', async () => {
    const result = await toolkit().bash('node -e "process.exit(3)"', 'check the exit code');
    expect(result.code).toBe(3);
    expect(actions[0]?.detail).toBe('exit 3 · 0 lines');
  });

  it('refuses to run without an intent', async () => {
    await expect(toolkit().bash('echo hi', '')).rejects.toThrow(/needs to know why/);
  });
});
