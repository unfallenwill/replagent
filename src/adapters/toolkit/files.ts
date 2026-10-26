import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  cutText,
  displayPath,
  errorMessage,
  GLOB_MAX_RESULTS,
  READ_MAX_CHARS,
  type ReadOptions,
  requireIntent,
  type ToolAction,
  type Toolkit,
  type ToolkitOptions,
  toSlashes,
} from './toolkit.js';

/**
 * The three ways of looking at a filesystem: read one file, look at one
 * directory, and find files by name.
 *
 * All three take the intent as their second argument, and all three report
 * what they did in a line the human can read.
 */

/** Read a file, or a range of lines from it. */
export async function readFile(
  options: ToolkitOptions,
  file: string,
  intent: unknown,
  readOptions?: ReadOptions,
): Promise<string> {
  const why = requireIntent('read', intent);
  const target = path.resolve(options.cwd, file);

  let text: string;
  try {
    text = await fs.readFile(target, 'utf8');
  } catch (error) {
    throw new Error(`read could not read ${file}: ${errorMessage(error)}`);
  }

  const lines = splitLines(text);
  const from = readOptions?.from ?? 1;
  const to = readOptions?.to ?? lines.length;
  const chosen = from > 1 || to < lines.length ? sliceLines(lines, from, to) : text;

  const shown = displayPath(options.cwd, target);
  report(options, {
    tool: `read ${shown}`,
    intent: why,
    detail: `${countLines(chosen)} lines`,
  });

  return cutText(chosen, READ_MAX_CHARS);
}

/** The names in a directory, with the directories marked. */
export async function listDirectory(
  options: ToolkitOptions,
  dir: string,
  intent: unknown,
): Promise<string[]> {
  const why = requireIntent('ls', intent);
  const target = path.resolve(options.cwd, dir);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    throw new Error(`ls could not list ${dir}: ${errorMessage(error)}`);
  }

  entries.sort((left, right) => {
    const leftRank = left.isDirectory() ? 0 : 1;
    const rightRank = right.isDirectory() ? 0 : 1;
    return leftRank - rightRank || left.name.localeCompare(right.name);
  });

  const names = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  const shown = displayPath(options.cwd, target);
  report(options, {
    tool: `ls ${shown}`,
    intent: why,
    detail: `${names.length} entries`,
  });

  return names;
}

/** The files that match a pattern. */
export async function findFiles(
  options: ToolkitOptions,
  pattern: string,
  intent: unknown,
): Promise<string[]> {
  const why = requireIntent('glob', intent);

  const found: string[] = [];
  try {
    for await (const entry of fs.glob(pattern, { cwd: options.cwd, withFileTypes: true })) {
      if (entry.isDirectory()) {
        continue;
      }
      const relative = toSlashes(
        path.relative(options.cwd, path.join(entry.parentPath, entry.name)),
      );
      if (isIgnored(relative)) {
        continue;
      }
      found.push(relative);
    }
  } catch (error) {
    throw new Error(`glob could not run ${pattern}: ${errorMessage(error)}`);
  }

  found.sort();
  const shown = found.slice(0, GLOB_MAX_RESULTS);
  report(options, {
    tool: `glob ${pattern}`,
    intent: why,
    detail:
      shown.length === found.length
        ? `${shown.length} files`
        : `${shown.length} of ${found.length} files`,
  });

  return shown;
}

/** The toolkit's three ways of looking at files. */
export function fileTools(options: ToolkitOptions): Pick<Toolkit, 'read' | 'ls' | 'glob'> {
  return {
    read: (file, intent, readOptions) => readFile(options, file, intent, readOptions),
    ls: (dir, intent) => listDirectory(options, dir, intent),
    glob: (pattern, intent) => findFiles(options, pattern, intent),
  };
}

/** Directories that are never worth finding files in. */
const IGNORED = ['node_modules/', '.git/'];

function isIgnored(relative: string): boolean {
  return IGNORED.some((prefix) => relative.startsWith(prefix) || relative.includes(`/${prefix}`));
}

/** The lines between two numbers, counting from one. */
function sliceLines(lines: readonly string[], from: number, to: number): string {
  const start = Math.max(0, from - 1);
  const end = Math.min(lines.length, Math.max(from, to));
  return lines.slice(start, end).join('\n');
}

function countLines(text: string): number {
  return splitLines(text).length;
}

/**
 * The lines of a text.
 *
 * A file that ends with a newline ends with a line, not with an empty one
 * after it - so the trailing empty piece is not a line of its own.
 */
function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

function report(options: ToolkitOptions, action: ToolAction): void {
  options.onAction(action);
}
