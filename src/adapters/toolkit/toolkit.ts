import path from 'node:path';

/**
 * The toolkit: the things an agent does most often, made easy.
 *
 * The language is the tool - the model can already `require` a module and
 * call it. What the toolkit adds is not capability but ergonomics: a
 * helper that reports what it did, and takes the reason for the call
 * along with it.
 *
 * That reason is the point. A tool call without an intent is a line of
 * code the human has to read to find out what it was for. So every helper
 * takes the intent as its second argument, refuses to run without one, and
 * shows it in the transcript.
 */

/** What a tool did, for the human to read. */
export interface ToolAction {
  /** The tool and what it was pointed at. */
  readonly tool: string;
  /** The model's own words about why it called the tool. */
  readonly intent: string;
  /** What came of it, in a line. */
  readonly detail: string;
}

export interface ToolkitOptions {
  /** The directory relative paths resolve from. */
  readonly cwd: string;
  /** Called after every action, so the human can watch it happen. */
  readonly onAction: (action: ToolAction) => void;
}

/** The line range of a file, for `read`. */
export interface ReadOptions {
  /** The first line to read, counting from one. */
  readonly from?: number;
  /** The last line to read, counting from one and including it. */
  readonly to?: number;
}

/** What `edit` was asked to change. */
export interface EditChange {
  /** The text to find. */
  readonly old: string;
  /** The text to put in its place. */
  readonly new: string;
}

/** What `edit` did. */
export interface EditResult {
  /** The file that was changed. */
  readonly path: string;
  /** The first line of the text that was replaced, counting from one. */
  readonly from: number;
  /** The last line of the text that was replaced. */
  readonly to: number;
  /** How many lines of context the match had to grow by to be unique. */
  readonly expanded: number;
}

export interface BashOptions {
  /** How long the command may run, in milliseconds. */
  readonly timeout?: number;
  /** The directory to run it in. */
  readonly cwd?: string;
}

/** What a command left behind. */
export interface BashResult {
  readonly stdout: string;
  readonly stderr: string;
  /** The exit code, or null when the command was killed. */
  readonly code: number | null;
}

/** The toolkit as the model sees it. */
export interface Toolkit {
  readonly read: (file: string, intent: string, options?: ReadOptions) => Promise<string>;
  readonly ls: (dir: string, intent: string) => Promise<string[]>;
  readonly glob: (pattern: string, intent: string) => Promise<string[]>;
  readonly edit: (file: string, intent: string, change: EditChange) => Promise<EditResult>;
  readonly bash: (command: string, intent: string, options?: BashOptions) => Promise<BashResult>;
}

/** How much of a file one read may hand over. */
export const READ_MAX_CHARS = 200_000;

/** How much a command may print, on each stream. */
export const BASH_MAX_OUTPUT = 64_000;

/** How long a command may run. */
export const BASH_TIMEOUT = 120_000;

/** How many files one glob may find. */
export const GLOB_MAX_RESULTS = 2_000;

/**
 * The intent is not optional.
 *
 * Without it a tool call is a line of code the human has to read to find
 * out what it was for, and that is the whole reason the toolkit exists.
 */
export function requireIntent(tool: string, intent: unknown): string {
  if (typeof intent !== 'string' || intent.trim().length === 0) {
    throw new Error(
      `${tool} needs to know why. Call it as ${tool}(path, "what you are trying to find out", ...). ` +
        'The intent is the second argument, and it is a plain string.',
    );
  }
  return intent.trim();
}

/**
 * The path as the human should read it.
 *
 * Relative to the working directory when it can be, with forward slashes
 * so it looks the same everywhere.
 */
export function displayPath(cwd: string, target: string): string {
  const relative = path.relative(cwd, target);
  if (relative.length === 0) {
    return '.';
  }
  if (relative.startsWith('..')) {
    return toSlashes(target);
  }
  return toSlashes(relative);
}

/** The same path, with forward slashes. */
export function toSlashes(value: string): string {
  return value.split(path.sep).join('/');
}

/** The message of an error, without the stack. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Cut a long text down, saying how much was left out.
 *
 * The model is told what it is not seeing, so it can go and ask for the
 * rest rather than draw a conclusion from half a file.
 */
export function cutText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n… ${text.length - limit} more characters`;
}
