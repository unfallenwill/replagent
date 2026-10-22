import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { displayPath, elidePath, readLocation } from '../src/adapters/workspace/location.js';

const created: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'replagent-'));
  created.push(directory);
  return directory;
}

function writeHead(root: string, text: string): void {
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'HEAD'), text);
}

function slashes(value: string): string {
  return value.split(path.sep).join('/');
}

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('displayPath', () => {
  it('writes the home directory as a tilde', () => {
    const home = path.resolve(path.sep, 'home', 'me');
    expect(displayPath(path.join(home, 'GitHub', 'replagent'), home)).toBe('~/GitHub/replagent');
  });

  it('is just the tilde at home', () => {
    const home = path.resolve(path.sep, 'home', 'me');
    expect(displayPath(home, home)).toBe('~');
  });

  it('leaves a path outside the home directory alone', () => {
    const outside = path.resolve(path.sep, 'elsewhere', 'project');
    const home = path.resolve(path.sep, 'home', 'me');
    expect(displayPath(outside, home)).toBe(slashes(outside));
  });
});

describe('elidePath', () => {
  it('shortens from the left, keeping the end', () => {
    expect(elidePath('~/GitHub/replagent', 2)).toBe('…/GitHub/replagent');
    expect(elidePath('~/GitHub/replagent', 1)).toBe('…/replagent');
  });

  it('leaves a path that is already short alone', () => {
    expect(elidePath('~', 1)).toBe('~');
    expect(elidePath('~/scratch', 2)).toBe('~/scratch');
  });
});

describe('readLocation', () => {
  it('reads the branch out of HEAD', () => {
    const root = scratch();
    writeHead(root, 'ref: refs/heads/feature/status-bar\n');

    expect(readLocation(root).branch).toBe('feature/status-bar');
  });

  it('finds the repository from a subdirectory', () => {
    const root = scratch();
    writeHead(root, 'ref: refs/heads/main\n');
    const nested = path.join(root, 'src', 'adapters');
    mkdirSync(nested, { recursive: true });

    expect(readLocation(nested).branch).toBe('main');
  });

  it('reads the short commit when HEAD is detached', () => {
    const root = scratch();
    writeHead(root, `${'a1b2c3d4'.repeat(5)}\n`);

    expect(readLocation(root).branch).toBe('a1b2c3d');
  });

  it('follows the gitdir pointer of a worktree', () => {
    const root = scratch();
    const gitdir = path.join(root, 'repo', '.git', 'worktrees', 'wt');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/wt-branch\n');

    const worktree = path.join(root, 'wt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitdir}\n`);

    expect(readLocation(worktree).branch).toBe('wt-branch');
  });

  it('reports no branch outside a repository', () => {
    const root = scratch();
    mkdirSync(path.join(root, 'plain'), { recursive: true });

    expect(readLocation(path.join(root, 'plain')).branch).toBeUndefined();
  });

  it('reports the directory it was given', () => {
    const root = scratch();
    writeHead(root, 'ref: refs/heads/main\n');

    expect(readLocation(path.join(root, 'src'), root).path).toBe('~/src');
  });
});
