import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Where the agent is standing.
 *
 * Read from the filesystem rather than asked of git: the status bar refreshes
 * while a turn runs, and spawning a process every second to learn one word
 * is a cost the bar should not carry.
 */
export interface Location {
  /** The working directory, with the home directory written as `~`. */
  readonly path: string;
  /** The branch HEAD points at, or the short commit when HEAD is detached. */
  readonly branch: string | undefined;
}

export function readLocation(cwd: string, home: string = homedir()): Location {
  return { path: displayPath(cwd, home), branch: readBranch(cwd) };
}

/** The directory as a person writes it: `~/GitHub/replagent`. */
export function displayPath(cwd: string, home: string): string {
  const relative = path.relative(home, cwd);
  if (relative.length === 0) {
    return '~';
  }
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`);
  if (outside || path.isAbsolute(relative)) {
    return toSlashes(cwd);
  }
  return `~/${toSlashes(relative)}`;
}

function toSlashes(value: string): string {
  return value.split(path.sep).join('/');
}

/**
 * Shorten a path from the left, keeping its tail: `…/GitHub/replagent`.
 * The end of a path is the part that says where you are; the beginning is
 * the part a narrow terminal can do without.
 */
export function elidePath(displayed: string, keep: number): string {
  const segments = displayed.split('/').filter((segment) => segment.length > 0);
  if (segments.length <= keep) {
    return displayed;
  }
  return `…/${segments.slice(-keep).join('/')}`;
}

/**
 * The branch of the repository `cwd` is in, if it is in one.
 *
 * Walks up instead of running git: `.git` is a directory in a normal
 * checkout and a file holding `gitdir:` in a worktree or submodule, and in
 * both cases HEAD is what says which branch is checked out. Anything
 * unreadable is reported as "not a repository" rather than guessed at.
 */
function readBranch(cwd: string): string | undefined {
  let directory = cwd;
  for (;;) {
    const head = readHead(path.join(directory, '.git'));
    if (head !== undefined) {
      return parseHead(head);
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

/** The contents of HEAD for the repository whose `.git` is at `gitPath`. */
function readHead(gitPath: string): string | undefined {
  try {
    if (statSync(gitPath).isDirectory()) {
      return readFileSync(path.join(gitPath, 'HEAD'), 'utf8');
    }
    const pointer = readFileSync(gitPath, 'utf8').trim();
    if (!pointer.startsWith('gitdir:')) {
      return undefined;
    }
    const target = pointer.slice('gitdir:'.length).trim();
    const gitdir = path.resolve(path.dirname(gitPath), target);
    return readFileSync(path.join(gitdir, 'HEAD'), 'utf8');
  } catch {
    return undefined;
  }
}

function parseHead(raw: string): string | undefined {
  const text = raw.trim();
  const branchPrefix = 'ref: refs/heads/';
  if (text.startsWith(branchPrefix)) {
    return text.slice(branchPrefix.length);
  }
  if (/^[0-9a-f]{40}$/i.test(text)) {
    return text.slice(0, 7);
  }
  return undefined;
}
