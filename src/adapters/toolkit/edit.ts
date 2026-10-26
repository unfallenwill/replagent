import fs from 'node:fs/promises';
import path from 'node:path';
import {
  displayPath,
  type EditChange,
  type EditResult,
  errorMessage,
  requireIntent,
  type Toolkit,
  type ToolkitOptions,
} from './toolkit.js';

/**
 * Changing a file, precisely.
 *
 * The hard part of an edit is not the writing down of the new text; it is
 * knowing which text the model meant. A model that read a file and quotes
 * a line back may be quoting a line that appears three times, and editing
 * the wrong one is worse than not editing at all.
 *
 * So the match is grown until it is unique. The seed is looked for as it
 * is; if it turns up more than once, the region around each candidate is
 * widened, a line at a time, until exactly one of them can be told apart
 * from every other place in the file. Only that one is touched.
 *
 * Growing the region identifies the place; it never widens what gets
 * replaced. The text that is written back is always the seed and nothing
 * else, so a match that needed three lines of context to be found still
 * replaces one line.
 */

/** How many lines of context a match may grow by before it gives up. */
const MAX_CONTEXT_LINES = 30;

/** Change a file, by replacing one piece of text with another. */
export async function editFile(
  options: ToolkitOptions,
  file: string,
  intent: unknown,
  change: unknown,
): Promise<EditResult> {
  const why = requireIntent('edit', intent);
  const wanted = readChange(change);
  const target = path.resolve(options.cwd, file);

  let text: string;
  try {
    text = await fs.readFile(target, 'utf8');
  } catch (error) {
    throw new Error(`edit could not read ${file}: ${errorMessage(error)}`);
  }

  const matches = findAll(text, wanted.old);
  if (matches.length === 0) {
    throw new Error(
      `edit could not find that text in ${file}. Read the file again and quote it exactly.`,
    );
  }

  const starts = lineStarts(text);
  const chosen = chooseMatch(text, starts, matches);
  if (chosen === undefined) {
    throw new Error(
      `edit could not tell which of the ${matches.length} places in ${file} you meant: ` +
        `${matches.map((match) => `line ${lineOf(starts, match.start) + 1}`).join(', ')}. ` +
        'Quote more of the file around it, so that only one place it fits.',
    );
  }

  const match = chosen.match;
  const updated = text.slice(0, match.start) + wanted.new + text.slice(match.end);
  try {
    await fs.writeFile(target, updated, 'utf8');
  } catch (error) {
    throw new Error(`edit could not write ${file}: ${errorMessage(error)}`);
  }

  const from = lineOf(starts, match.start) + 1;
  const to = lineOf(starts, match.end - 1) + 1;
  const shown = displayPath(options.cwd, target);
  options.onAction({
    tool: `edit ${shown}`,
    intent: why,
    detail: `${lineRange(from, to)}${chosen.level > 0 ? ` (${chosen.level} lines of context to make it unique)` : ''}`,
  });

  return { path: shown, from, to, expanded: chosen.level };
}

/**
 * The one match to change, when there is one that can be told apart.
 *
 * A single occurrence needs no context to be found; more than one does, and
 * the context that finds it is the context that grew.
 */
function chooseMatch(
  text: string,
  starts: readonly number[],
  matches: readonly { start: number; end: number }[],
): { match: { start: number; end: number }; level: number } | undefined {
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only !== undefined) {
    return { match: only, level: 0 };
  }
  return resolve(text, starts, matches);
}

/** The toolkit's way of changing a file. */
export function editTool(options: ToolkitOptions): Pick<Toolkit, 'edit'> {
  return {
    edit: (file, intent, change) => editFile(options, file, intent, change),
  };
}

/** What the model asked to change. */
function readChange(change: unknown): EditChange {
  if (change === null || typeof change !== 'object') {
    throw new Error(
      'edit needs the change as one object: edit(path, "why", { old: "the text to find", new: "the text to put there" }).',
    );
  }
  const record = change as Record<string, unknown>;
  const old = record['old'];
  const replacement = record['new'];
  if (typeof old !== 'string' || old.length === 0) {
    throw new Error('edit needs `old`: the exact text to find in the file.');
  }
  if (typeof replacement !== 'string') {
    throw new Error('edit needs `new`: the text to put in its place. Use "" to remove the text.');
  }
  return { old, new: replacement };
}

/** Every place the text turns up. */
function findAll(text: string, needle: string): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    found.push({ start: index, end: index + needle.length });
    index = text.indexOf(needle, index + 1);
  }
  return found;
}

/**
 * The one candidate that can be told apart from every other.
 *
 * Each candidate's region is widened a line at a time. A region that
 * occurs exactly once in the file identifies its candidate; when exactly
 * one candidate has reached that point, the match is found. When more than
 * one has - or none has - the quote is genuinely ambiguous and the caller
 * is told so.
 */
function resolve(
  text: string,
  starts: readonly number[],
  matches: readonly { start: number; end: number }[],
): { match: { start: number; end: number }; level: number } | undefined {
  for (let level = 1; level <= MAX_CONTEXT_LINES; level += 1) {
    const unique: { match: { start: number; end: number }; level: number }[] = [];
    let allWholeFile = true;

    for (const match of matches) {
      const region = regionOf(text, starts, match, level);
      if (region.start !== 0 || region.end !== text.length) {
        allWholeFile = false;
      }
      const block = text.slice(region.start, region.end);
      if (countOccurrences(text, block) === 1) {
        unique.push({ match, level });
      }
    }

    if (unique.length === 1) {
      return unique[0];
    }
    if (allWholeFile) {
      break;
    }
  }

  return undefined;
}

/** The lines around a match, widened by `level` lines on each side. */
function regionOf(
  text: string,
  starts: readonly number[],
  match: { start: number; end: number },
  level: number,
): { start: number; end: number } {
  const firstLine = lineOf(starts, match.start);
  const lastLine = lineOf(starts, match.end - 1);
  const fromLine = Math.max(0, firstLine - level);
  const toLine = Math.min(starts.length - 1, lastLine + level);
  const start = starts[fromLine] ?? 0;
  const end = toLine + 1 < starts.length ? (starts[toLine + 1] ?? text.length) - 1 : text.length;
  return { start, end };
}

/** Where each line begins. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

/** The line an offset falls on, counting from zero. */
function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/** How many times a piece of text appears. */
function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + 1);
  }
  return count;
}

/** A line range, as a person would say it. */
function lineRange(from: number, to: number): string {
  return from === to ? `line ${from}` : `lines ${from}-${to}`;
}
