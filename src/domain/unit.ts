/**
 * What a legal reply looks like.
 *
 * The parser is the arbiter: a reply is legal when it is one unit, and
 * nothing else gets a vote. This file is a scanner rather than a parser -
 * it walks the source the way JavaScript reads it (strings, templates,
 * comments and regular expressions are skipped) and looks for one call to
 * `step` with a name, a description and a program.
 *
 * It is hand-written because the domain may not depend on anything outside
 * itself. It is also deliberately unsure: a wrong answer here costs a
 * round trip, so the rule is to say no only when it is certain. When the
 * scanner cannot tell, it says yes and lets `step` decide - `step` checks
 * the name and the description itself, before it runs anything, so a unit
 * that is not a unit has no effects either way.
 */

export interface UnitScan {
  /** True when the reply is one well-formed unit. */
  readonly ok: boolean;
  /** What is wrong with the reply, when it is. */
  readonly problem: string | undefined;
}

/** What the agent is told when its reply was not a unit at all. */
export const NOT_A_UNIT: string =
  'Your reply was not a unit. A unit is one call to step: ' +
  'await step("what this is called", "what it does", async (name, description) => { ... }); ' +
  'Reply with that and nothing else.';

/** What the agent is told when its reply carried more than one unit. */
export function tooManyUnits(count: number): string {
  return (
    `Your reply carried ${count} units, and a reply is one unit. ` +
    'Call step once, and do everything else inside that one program.'
  );
}

/** What the agent is told when the unit had no name. */
export const MISSING_NAME: string =
  'A unit needs a name: step("what this is called", "what it does", async (name, description) => { ... }). ' +
  'The name is a plain string with a word or two in it.';

/** What the agent is told when the unit had no description. */
export const MISSING_DESCRIPTION: string =
  'A unit needs a description of what it does: ' +
  'step("what this is called", "what it does", async (name, description) => { ... }). ' +
  'The description is a plain string, and it is what the human reads instead of your code.';

/** What the agent is told when the unit had nothing to run. */
export const MISSING_BODY: string =
  'A unit needs a program to run: ' +
  'step("what this is called", "what it does", async (name, description) => { ... }). ' +
  'The third argument is the function that does the work.';

/** The kinds of token the scanner needs to tell apart. */
type TokenKind = 'ident' | 'string' | 'template' | 'number' | 'punct';

interface Token {
  readonly kind: TokenKind;
  /** The identifier's name, the literal's text, or the punctuation. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
  /** True for a template literal that has values in it. */
  readonly dynamic: boolean;
}

/**
 * What an argument turned out to be.
 *
 * `other` is the interesting one: the argument is there, and it is known
 * that it is not the thing it should be. `undefined` is not a name, and
 * saying so before the program runs saves the model a round trip.
 */
type ArgumentKind = 'missing' | 'string' | 'other' | 'unknown';

/** One argument of a call, as the scanner saw it. */
interface Argument {
  readonly kind: ArgumentKind;
  /** The literal's text, when it is one. */
  readonly value: string;
}

/** One call to `step`. */
interface StepCall {
  readonly name: Argument;
  readonly description: Argument;
  readonly body: Argument;
  /** Where the call ended, so the scan can carry on from there. */
  readonly end: number;
}

/** The values that are certainly not a name, a description or a program. */
const NOT_A_STRING: ReadonlySet<string> = new Set(['undefined', 'null', 'true', 'false']);

/** Keywords that can be followed by an expression, and so by a regular expression. */
const REGEX_AFTER_KEYWORD: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'do',
  'else',
  'case',
  'yield',
  'await',
  'throw',
]);

/** The escapes a string literal can carry. */
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
};

/**
 * Is this reply one unit?
 */
export function scanUnit(code: string): UnitScan {
  const calls = findStepCalls(code);

  if (calls.length === 0) {
    return { ok: false, problem: NOT_A_UNIT };
  }
  if (calls.length > 1) {
    return { ok: false, problem: tooManyUnits(calls.length) };
  }
  return checkCall(calls[0] as StepCall);
}

/** Does the call have what a unit needs? */
function checkCall(call: StepCall): UnitScan {
  const name = argumentProblem(call.name, MISSING_NAME);
  if (name !== undefined) {
    return { ok: false, problem: name };
  }
  const description = argumentProblem(call.description, MISSING_DESCRIPTION);
  if (description !== undefined) {
    return { ok: false, problem: description };
  }
  const body = argumentProblem(call.body, MISSING_BODY);
  if (body !== undefined) {
    return { ok: false, problem: body };
  }
  return { ok: true, problem: undefined };
}

/**
 * What is wrong with an argument, when there is something wrong with it.
 *
 * An argument that is not there, and one that is certainly not a string,
 * are the same kind of mistake: the unit cannot have it. A string that
 * holds nothing is the same mistake again.
 */
function argumentProblem(argument: Argument, problem: string): string | undefined {
  if (argument.kind === 'missing' || argument.kind === 'other') {
    return problem;
  }
  if (argument.kind === 'string' && argument.value.trim().length === 0) {
    return problem;
  }
  return undefined;
}

/**
 * Every call to `step` in the source.
 *
 * A call is a `step` that is not a member access (`foo.step` is somebody
 * else's) and not a declaration (`function step` is a definition, not a
 * call).
 */
function findStepCalls(code: string): StepCall[] {
  const calls: StepCall[] = [];
  let index = 0;
  let last: Token | undefined;

  while (index < code.length) {
    const token = readToken(code, index, last);
    if (token === undefined) {
      break;
    }
    index = token.end;

    if (token.kind === 'ident' && token.value === 'step' && isCallable(last)) {
      const open = skipTrivia(code, token.end);
      if (code[open] === '(') {
        const call = readStepCall(code, open);
        calls.push(call);
        index = call.end;
        last = { kind: 'punct', value: ')', start: call.end - 1, end: call.end, dynamic: false };
        continue;
      }
    }
    last = token;
  }

  return calls;
}

/**
 * Is this `step` the one the REPL provides?
 *
 * `foo.step(...)` belongs to something else, and `function step` is a
 * declaration rather than a call.
 */
function isCallable(last: Token | undefined): boolean {
  if (last === undefined) {
    return true;
  }
  if (last.kind === 'punct') {
    return last.value !== '.' && last.value !== '?.';
  }
  if (last.kind === 'ident') {
    return last.value !== 'function' && last.value !== 'class';
  }
  return true;
}

/**
 * Read the arguments of the call that starts at `open`.
 */
function readStepCall(code: string, open: number): StepCall {
  const ranges: Range[] = [];
  let index = open + 1;
  let depth = 0;
  let last: Token | undefined;
  let first: Token | undefined;
  let previous: Token | undefined;

  while (index < code.length) {
    const token = readToken(code, index, last);
    if (token === undefined) {
      break;
    }
    index = token.end;
    last = token;

    const effect = bracketEffect(token, depth);
    if (effect === 'close') {
      pushRange(ranges, first, previous);
      break;
    }
    if (effect === 'open') {
      depth += 1;
    } else if (effect === 'inner-close') {
      depth -= 1;
    } else if (isComma(token, depth)) {
      pushRange(ranges, first, previous);
      first = undefined;
      previous = undefined;
      continue;
    }

    if (first === undefined) {
      first = token;
    }
    previous = token;
  }

  return {
    name: argumentAt(ranges, 0),
    description: argumentAt(ranges, 1),
    body: argumentAt(ranges, 2),
    end: index,
  };
}

/** What a bracket does to the argument list it sits in. */
type BracketEffect = 'open' | 'close' | 'inner-close' | 'none';

/**
 * What this token does to the nesting.
 *
 * A bracket that closes the call itself is the end of the arguments; one
 * that closes something nested inside an argument is just a bracket.
 */
function bracketEffect(token: Token, depth: number): BracketEffect {
  if (token.kind !== 'punct') {
    return 'none';
  }
  if (token.value === '(' || token.value === '[' || token.value === '{') {
    return 'open';
  }
  if (token.value === ')' || token.value === ']' || token.value === '}') {
    return depth === 0 ? 'close' : 'inner-close';
  }
  return 'none';
}

/** Is this the comma that separates two arguments? */
function isComma(token: Token, depth: number): boolean {
  return token.kind === 'punct' && token.value === ',' && depth === 0;
}

/** The tokens of one argument. */
interface Range {
  readonly first: Token;
  readonly last: Token;
}

/** The range of the argument that just ended, when it had any tokens. */
function rangeOf(first: Token | undefined, previous: Token | undefined): Range | undefined {
  if (first === undefined) {
    return undefined;
  }
  return { first, last: previous ?? first };
}

/** Keep the range of an argument that had any tokens in it. */
function pushRange(ranges: Range[], first: Token | undefined, previous: Token | undefined): void {
  const range = rangeOf(first, previous);
  if (range !== undefined) {
    ranges.push(range);
  }
}

/** What the argument at `position` turned out to be. */
function argumentAt(ranges: readonly Range[], position: number): Argument {
  const range = ranges[position];
  if (range === undefined) {
    return { kind: 'missing', value: '' };
  }
  // One token, and it is a literal: the text is known.
  if (range.first === range.last) {
    const token = range.first;
    if (token.kind === 'string') {
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'template') {
      return token.dynamic
        ? { kind: 'unknown', value: '' }
        : { kind: 'string', value: token.value };
    }
    if (token.kind === 'number' || NOT_A_STRING.has(token.value)) {
      return { kind: 'other', value: '' };
    }
  }
  // Anything else is an expression. It is there, but its text is not known
  // without running it - and `step` will check it when it does.
  return { kind: 'unknown', value: '' };
}

/**
 * The next token, skipping whitespace and comments.
 *
 * Comments are not tokens: the neighbours of a token are the ones that
 * matter for reading the code, and a comment in the middle of an argument
 * list changes nothing.
 */
function readToken(code: string, from: number, last: Token | undefined): Token | undefined {
  const start = skipTrivia(code, from);
  if (start >= code.length) {
    return undefined;
  }

  const char = code[start] as string;

  if (char === '"' || char === "'") {
    return readString(code, start, char);
  }
  if (char === '`') {
    return readTemplate(code, start);
  }
  if (char === '/') {
    return regexAllowed(last) ? readRegex(code, start) : punctuation(start, start + 1, '/');
  }
  if (isIdentStart(char)) {
    return readIdent(code, start);
  }
  if (isDigit(char)) {
    return readNumber(code, start);
  }
  return readPunctuation(code, start);
}

/** Read an identifier, and the name it carries. */
function readIdent(code: string, start: number): Token {
  let end = start + 1;
  while (end < code.length && isIdentPart(code[end] as string)) {
    end += 1;
  }
  return { kind: 'ident', value: code.slice(start, end), start, end, dynamic: false };
}

/** Read a number, and the digits it carries. */
function readNumber(code: string, start: number): Token {
  let end = start + 1;
  while (end < code.length && /[0-9a-zA-Z._]/.test(code[end] as string)) {
    end += 1;
  }
  return { kind: 'number', value: code.slice(start, end), start, end, dynamic: false };
}

/** Read a punctuation mark, and the operators that are two characters long. */
function readPunctuation(code: string, start: number): Token {
  const char = code[start] as string;
  if (char === '?' && code[start + 1] === '.') {
    return punctuation(start, start + 2, '?.');
  }
  if ((char === '+' || char === '-') && code[start + 1] === char) {
    return punctuation(start, start + 2, char + char);
  }
  return punctuation(start, start + 1, char);
}

function punctuation(start: number, end: number, value: string): Token {
  return { kind: 'punct', value, start, end, dynamic: false };
}

/** Read a string literal, and the text it holds. */
function readString(code: string, start: number, quote: string): Token {
  let index = start + 1;
  let value = '';

  while (index < code.length) {
    const char = code[index] as string;
    if (char === '\\') {
      const escaped = readEscape(code, index);
      value += escaped.value;
      index = escaped.end;
      continue;
    }
    if (char === quote) {
      index += 1;
      break;
    }
    if (char === '\n') {
      break;
    }
    value += char;
    index += 1;
  }

  return { kind: 'string', value, start, end: index, dynamic: false };
}

/** Read a template literal, and the text it holds. */
function readTemplate(code: string, start: number): Token {
  let index = start + 1;
  let value = '';
  let dynamic = false;

  while (index < code.length) {
    const char = code[index] as string;
    if (char === '\\') {
      const escaped = readEscape(code, index);
      value += escaped.value;
      index = escaped.end;
      continue;
    }
    if (char === '`') {
      index += 1;
      break;
    }
    if (char === '$' && code[index + 1] === '{') {
      dynamic = true;
      index = skipTemplateExpression(code, index + 2);
      continue;
    }
    value += char;
    index += 1;
  }

  return { kind: 'template', value, start, end: index, dynamic };
}

/** Skip a `${...}` and everything inside it. */
function skipTemplateExpression(code: string, from: number): number {
  let index = from;
  let depth = 0;
  let last: Token | undefined;

  while (index < code.length) {
    const token = readToken(code, index, last);
    if (token === undefined) {
      return code.length;
    }
    index = token.end;
    last = token;
    if (token.kind === 'punct') {
      if (token.value === '{') {
        depth += 1;
      } else if (token.value === '}') {
        if (depth === 0) {
          return index;
        }
        depth -= 1;
      }
    }
  }

  return code.length;
}

/** Read a regular expression literal. */
function readRegex(code: string, start: number): Token {
  let index = start + 1;
  let inClass = false;

  while (index < code.length) {
    const char = code[index] as string;
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '[') {
      inClass = true;
    } else if (char === ']') {
      inClass = false;
    } else if (char === '/' && !inClass) {
      index += 1;
      break;
    } else if (char === '\n') {
      break;
    }
    index += 1;
  }

  while (index < code.length && isIdentPart(code[index] as string)) {
    index += 1;
  }

  return { kind: 'punct', value: '/regex/', start, end: index, dynamic: false };
}

/**
 * Is a `/` here the start of a regular expression?
 *
 * After a value it is a division; after an operator, a keyword or nothing
 * at all it is a regular expression.
 */
function regexAllowed(last: Token | undefined): boolean {
  if (last === undefined) {
    return true;
  }
  if (last.kind === 'ident') {
    return REGEX_AFTER_KEYWORD.has(last.value);
  }
  if (last.kind === 'punct') {
    return !(
      last.value === ')' ||
      last.value === ']' ||
      last.value === '}' ||
      last.value === '++' ||
      last.value === '--'
    );
  }
  return false;
}

/** Read one escape sequence and the text it stands for. */
function readEscape(code: string, at: number): { value: string; end: number } {
  const char = code[at + 1];
  if (char === undefined) {
    return { value: '\\', end: at + 1 };
  }

  const simple = SIMPLE_ESCAPES[char];
  if (simple !== undefined) {
    return { value: simple, end: at + 2 };
  }
  if (char === 'x') {
    const hex = code.slice(at + 2, at + 4);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      return { value: String.fromCharCode(Number.parseInt(hex, 16)), end: at + 4 };
    }
    return { value: 'x', end: at + 2 };
  }
  if (char === 'u') {
    return readUnicodeEscape(code, at);
  }
  if (char === '\n') {
    return { value: '', end: at + 2 };
  }
  if (char === '\r') {
    return { value: '', end: code[at + 2] === '\n' ? at + 3 : at + 2 };
  }
  return { value: char, end: at + 2 };
}

/** Read a `\uXXXX` or `\u{...}` escape. */
function readUnicodeEscape(code: string, at: number): { value: string; end: number } {
  if (code[at + 2] === '{') {
    const close = code.indexOf('}', at + 3);
    if (close !== -1) {
      const hex = code.slice(at + 3, close);
      if (/^[0-9a-fA-F]{1,6}$/.test(hex)) {
        return { value: String.fromCodePoint(Number.parseInt(hex, 16)), end: close + 1 };
      }
    }
    return { value: 'u', end: at + 2 };
  }

  const hex = code.slice(at + 2, at + 6);
  if (/^[0-9a-fA-F]{4}$/.test(hex)) {
    return { value: String.fromCharCode(Number.parseInt(hex, 16)), end: at + 6 };
  }
  return { value: 'u', end: at + 2 };
}

/** Skip whitespace and comments. */
function skipTrivia(code: string, from: number): number {
  let index = from;

  while (index < code.length) {
    const char = code[index] as string;
    if (isSpace(char)) {
      index += 1;
      continue;
    }
    const after = skipComment(code, index);
    if (after !== index) {
      index = after;
      continue;
    }
    break;
  }

  return index;
}

/** The characters a program can have between its tokens. */
function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

/**
 * The end of the comment at `index`, or `index` itself when there is none.
 *
 * A line comment runs to the end of the line, a block comment to the star
 * and the slash that close it, and a lone slash is not a comment at all.
 */
function skipComment(code: string, index: number): number {
  if (code[index] !== '/') {
    return index;
  }
  const next = code[index + 1];
  if (next === '/') {
    const end = code.indexOf('\n', index + 2);
    return end === -1 ? code.length : end + 1;
  }
  if (next === '*') {
    const end = code.indexOf('*/', index + 2);
    return end === -1 ? code.length : end + 2;
  }
  return index;
}

function isIdentStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function isIdentPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}
