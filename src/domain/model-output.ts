/**
 * The response hook.
 *
 * Everything the model produces passes through here before it reaches the
 * REPL. The hook is a pipeline of pure steps, so every one of them can be
 * tested on its own:
 *
 *   1. normalize - strip invisible characters that some gateways inject
 *   2. unwrap    - dig the code out of a tool call envelope
 *   3. validate  - is this JavaScript at all?
 *
 * The code that comes out is what gets executed. The formatted version is
 * only ever used for display.
 */

import repl from 'node:repl';

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

/**
 * Any XML-ish tag. JavaScript almost never contains one: `a < b` needs a
 * space after the `<`, and comparisons without spaces are rare.
 */
const TAG = /<\/?[a-zA-Z_][\w.-]*(?:\s[^>]*)?\/?>/;

/**
 * Gateways rewrite their native tags into an obfuscated envelope - the
 * MiniMax one looks like `]<]minimax[>[`, but the name is theirs to change.
 * This matches the shape: a bracket, some punctuation, a word, punctuation, a
 * bracket.
 */
const ENVELOPE_PREFIX = /\][^a-zA-Z0-9]*[a-zA-Z]+[^a-zA-Z0-9]*\[/g;

/** Payload sections, most specific first. */
const CODE_SECTIONS = [
  /<content(?:\s[^>]*)?>([\s\S]*?)<\/content>/i,
  /<code(?:\s[^>]*)?>([\s\S]*?)<\/code>/i,
  /<tool_use(?:\s[^>]*)?>([\s\S]*?)<\/tool_use>/i,
  /<arguments(?:\s[^>]*)?>([\s\S]*?)<\/arguments>/i,
  /<parameter(?:\s[^>]*)?>([\s\S]*?)<\/parameter>/i,
  /<invoke(?:\s[^>]*)?>([\s\S]*?)<\/invoke>/i,
];

/** A payload tag that was never closed: take everything that follows it. */
const OPEN_SECTION = /<(?:content|code|invoke|parameter|arguments|input|source|text)(?:\s[^>]*)?>/i;

/** A markdown code fence. */
const CODE_FENCE = /```(?:js|javascript|node|mjs|cjs|ts|typescript)?[ \t]*\r?\n([\s\S]*?)```/i;

/** A JSON object, as used by the anthropic style tool call. */
const JSON_OBJECT = /\{[\s\S]*\}/;

/** Keys that hold the code in a JSON tool call. */
const CODE_KEYS = ['code', 'content', 'source', 'input', 'arguments', 'text', 'body'];

export interface PreparedCode {
  /** The JavaScript to execute. */
  readonly code: string;
  /** True when a tool-call envelope had to be unwrapped. */
  readonly unwrappedToolCall: boolean;
  /** True when the result is not valid JavaScript. */
  readonly invalidSyntax: boolean;
  /** Set when the output could not be turned into code at all. */
  readonly problem: string | undefined;
}

/** What the agent is told when it tries to call a tool that does not exist. */
export const TOOL_CALL_ERROR: string =
  'You emitted a tool call. This world has no tools: there is no function to call, ' +
  'no tool schema, no tool syntax. Write plain JavaScript - the REPL executes it ' +
  'directly and the value of the last expression comes back to you as an observation.';

/** What the agent is told when its reply is not JavaScript. */
export const NOT_JAVASCRIPT_ERROR: string =
  'Your reply was not valid JavaScript, so the REPL could not run it. ' +
  'Your reply is a program and nothing else: no prose, no markdown, no tool syntax.';

/** What the agent is told when it said nothing at all. */
export const EMPTY_REPLY_ERROR: string =
  'Your reply was empty, so there was nothing to run. Reply with a JavaScript program, ' +
  'even a tiny one.';

export function prepareModelOutput(text: string): PreparedCode {
  const normalized = text.replace(ZERO_WIDTH, '').trim();

  if (normalized.length === 0) {
    return {
      code: '',
      unwrappedToolCall: false,
      invalidSyntax: false,
      problem: EMPTY_REPLY_ERROR,
    };
  }

  if (!TAG.test(normalized) && !CODE_FENCE.test(normalized)) {
    return plain(normalized);
  }

  const stripped = normalized.replace(ENVELOPE_PREFIX, '');
  const payload = extractPayload(stripped);

  if (payload === undefined) {
    return {
      code: stripped,
      unwrappedToolCall: true,
      invalidSyntax: false,
      problem: TOOL_CALL_ERROR,
    };
  }

  return { ...plain(payload), unwrappedToolCall: true };
}

function plain(code: string): PreparedCode {
  return {
    code,
    unwrappedToolCall: false,
    invalidSyntax: code.length > 0 && !isValidSyntax(code),
    problem: undefined,
  };
}

function extractPayload(text: string): string | undefined {
  return fromSections(text) ?? fromFence(text) ?? fromJson(text) ?? fromOpenSection(text);
}

function fromSections(text: string): string | undefined {
  for (const pattern of CODE_SECTIONS) {
    const payload = pattern.exec(text)?.[1]?.trim();
    if (payload !== undefined && payload.length > 0) {
      return payload;
    }
  }
  return undefined;
}

function fromOpenSection(text: string): string | undefined {
  const match = OPEN_SECTION.exec(text);
  if (match === null) {
    return undefined;
  }
  const rest = text.slice(match.index + match[0].length);
  const payload = rest.replace(TAG, ' ').trim();
  return payload.length > 0 ? payload : undefined;
}

function fromFence(text: string): string | undefined {
  const payload = CODE_FENCE.exec(text)?.[1]?.trim();
  return payload !== undefined && payload.length > 0 ? payload : undefined;
}

function fromJson(text: string): string | undefined {
  const json = JSON_OBJECT.exec(text)?.[0];
  if (json === undefined) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }

  return findCode(parsed, 0);
}

function findCode(value: unknown, depth: number): string | undefined {
  if (depth > 4 || value === null || typeof value !== 'object') {
    return undefined;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      if (CODE_KEYS.includes(key) || looksLikeCode(entry)) {
        return entry.trim();
      }
    }
    const nested = findCode(entry, depth + 1);
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

/** Heuristic: does this string look like a program rather than a word? */
function looksLikeCode(value: string): boolean {
  return (
    value.includes(';') ||
    value.includes('\n') ||
    /\b(?:const|let|var|function|return|require|await|console)\b/.test(value)
  );
}

/**
 * `repl.isValidSyntax` exists at runtime but is not in the typings yet.
 */
function isValidSyntax(code: string): boolean {
  const checker = (repl as unknown as { isValidSyntax?: (source: string) => boolean })
    .isValidSyntax;
  if (checker === undefined) {
    return true;
  }
  return checker(code);
}
