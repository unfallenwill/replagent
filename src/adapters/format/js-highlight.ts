import type { CodeHighlighter } from '../../domain/ports/format.js';
import { blue, cyan, dim, green, yellow } from './ansi.js';

const KEYWORDS = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'of',
  'return',
  'set',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'async',
]);

const LITERALS = new Set(['true', 'false', 'null', 'undefined']);

const NUMBER = /[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?/y;
const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const SPACE = /\s+/y;

/** One piece of the code, coloured, and how long it was. */
interface Token {
  readonly text: string;
  readonly length: number;
}

/**
 * Colours JavaScript for the terminal.
 *
 * It is a highlighter, not a parser: it knows the parts of JavaScript that
 * are worth telling apart at a glance - what is a word, what is a string,
 * what is a number, what is a comment - and it leaves the rest alone. A
 * regular expression literal is the one thing it does not recognise, and it
 * is better to show one plainly than to colour the code after it wrongly.
 */
export class JsHighlighter implements CodeHighlighter {
  highlight(code: string): string {
    let out = '';
    let index = 0;

    while (index < code.length) {
      const token = this.#token(code, index);
      out += token.text;
      index += token.length;
    }

    return out;
  }

  #token(code: string, index: number): Token {
    const character = code[index] ?? '';
    const next = code[index + 1] ?? '';

    if (character === '/' && next === '/') {
      return this.#lineComment(code, index);
    }
    if (character === '/' && next === '*') {
      return this.#blockComment(code, index);
    }
    if (isQuote(character)) {
      return this.#string(code, index, character);
    }
    if (isDigit(character)) {
      return this.#number(code, index);
    }
    if (isIdentifierStart(character)) {
      return this.#word(code, index);
    }
    return this.#space(code, index);
  }

  #lineComment(code: string, index: number): Token {
    const stop = code.indexOf('\n', index);
    const end = stop === -1 ? code.length : stop;
    const text = code.slice(index, end);

    return { text: dim(text), length: text.length };
  }

  #blockComment(code: string, index: number): Token {
    const stop = code.indexOf('*/', index + 2);
    const end = stop === -1 ? code.length : stop + 2;
    const text = code.slice(index, end);

    return { text: dim(text), length: text.length };
  }

  #string(code: string, index: number, quote: string): Token {
    const end = endOfString(code, index, quote);
    const text = code.slice(index, end);

    return { text: green(text), length: text.length };
  }

  #number(code: string, index: number): Token {
    NUMBER.lastIndex = index;
    const text = NUMBER.exec(code)?.[0] ?? code[index] ?? '';

    return { text: yellow(text), length: text.length };
  }

  #word(code: string, index: number): Token {
    IDENTIFIER.lastIndex = index;
    const word = IDENTIFIER.exec(code)?.[0] ?? code[index] ?? '';

    return { text: colourFor(word, code, index + word.length), length: word.length };
  }

  #space(code: string, index: number): Token {
    SPACE.lastIndex = index;
    const text = SPACE.exec(code)?.[0] ?? code[index] ?? '';

    return { text, length: text.length };
  }
}

function colourFor(word: string, code: string, after: number): string {
  if (LITERALS.has(word)) {
    return yellow(word);
  }
  if (KEYWORDS.has(word)) {
    return cyan(word);
  }
  if (isCall(code, after)) {
    return blue(word);
  }
  return word;
}

/** A word followed by a bracket is a call, and calls are worth seeing. */
function isCall(code: string, from: number): boolean {
  let index = from;
  while (index < code.length && (code[index] === ' ' || code[index] === '\t')) {
    index += 1;
  }
  return code[index] === '(';
}

/**
 * Where the string ends.
 *
 * A backtick may hold a `${...}` with a string of its own inside it, and
 * that string may hold another. The whole lot is one string to the eye of
 * the reader anyway, so the nesting is followed rather than guessed at.
 */
function endOfString(code: string, from: number, quote: string): number {
  let index = from + 1;

  while (index < code.length) {
    const character = code[index] ?? '';

    if (character === '\\') {
      index += 2;
      continue;
    }

    if (quote === '`' && character === '$' && code[index + 1] === '{') {
      index = endOfTemplate(code, index + 2);
      continue;
    }

    if (character === quote) {
      return index + 1;
    }

    index += 1;
  }

  return code.length;
}

/** The end of the expression inside a `${...}`. */
function endOfTemplate(code: string, from: number): number {
  let index = from;
  let depth = 1;

  while (index < code.length && depth > 0) {
    const character = code[index] ?? '';

    if (character === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      index += 1;
      continue;
    }
    if (isQuote(character)) {
      index = endOfString(code, index, character);
      continue;
    }

    index += 1;
  }

  return index;
}

function isQuote(character: string): boolean {
  return character === '"' || character === "'" || character === '`';
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

function isIdentifierStart(character: string): boolean {
  return (
    (character >= 'a' && character <= 'z') ||
    (character >= 'A' && character <= 'Z') ||
    character === '_' ||
    character === '$'
  );
}
