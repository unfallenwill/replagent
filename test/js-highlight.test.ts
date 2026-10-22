import { describe, expect, it } from 'vitest';
import { JsHighlighter } from '../src/adapters/format/js-highlight.js';

const highlighter = new JsHighlighter();

/** The text with the escape sequences taken out. */
function plain(code: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the colours is the point
  return code.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('JsHighlighter', () => {
  it('leaves the code itself alone', () => {
    const code = 'const a = 1;\nconsole.log(a);';

    expect(plain(highlighter.highlight(code))).toBe(code);
  });

  it('colours keywords', () => {
    const coloured = highlighter.highlight('const a = 1;');

    expect(coloured).toContain('\u001b[36mconst\u001b[0m');
  });

  it('colours strings', () => {
    const coloured = highlighter.highlight('const a = "hello";');

    expect(coloured).toContain('\u001b[32m"hello"\u001b[0m');
  });

  it('colours numbers', () => {
    const coloured = highlighter.highlight('const a = 42;');

    expect(coloured).toContain('\u001b[33m42\u001b[0m');
  });

  it('colours comments', () => {
    const coloured = highlighter.highlight('// a note\nconst a = 1;');

    expect(coloured).toContain('\u001b[2m// a note\u001b[0m');
  });

  it('colours calls', () => {
    const coloured = highlighter.highlight('readFileSync("x")');

    expect(coloured).toContain('\u001b[34mreadFileSync\u001b[0m');
  });

  it('keeps a string that looks like code inside the string', () => {
    const coloured = highlighter.highlight('const a = "const b = 2";');

    expect(plain(coloured)).toBe('const a = "const b = 2";');
    expect(coloured).toContain('\u001b[32m"const b = 2"\u001b[0m');
  });

  it('does not end a string at an escaped quote', () => {
    const coloured = highlighter.highlight('const a = "say \\"hi\\"";');

    expect(plain(coloured)).toBe('const a = "say \\"hi\\"";');
  });

  it('follows a template literal into its expression', () => {
    const code = 'const a = `${name} said "hi"`;';
    const coloured = highlighter.highlight(code);

    expect(plain(coloured)).toBe(code);
  });

  it('survives an unterminated string', () => {
    expect(() => highlighter.highlight('const a = "unterminated')).not.toThrow();
  });
});
