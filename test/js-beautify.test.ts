import { describe, expect, it } from 'vitest';
import { JsBeautifyFormatter } from '../src/adapters/format/js-beautify.js';

describe('JsBeautifyFormatter', () => {
  it('breaks a one liner into lines', () => {
    const formatter = new JsBeautifyFormatter();
    const formatted = formatter.format('if (a) { console.log("x"); }');

    expect(formatted).toContain('\n');
    expect(formatted).toContain('console.log("x")');
  });

  it('uses the requested indentation', () => {
    const formatter = new JsBeautifyFormatter({ indentSize: 4 });
    const formatted = formatter.format('if (a) { console.log("x"); }');

    expect(formatted).toContain('\n    console.log');
  });

  it('returns the input when it cannot be parsed', () => {
    const formatter = new JsBeautifyFormatter();
    const broken = 'const = = = ;;;';

    expect(formatter.format(broken)).toBe(broken);
  });

  it('keeps the code intact', () => {
    const formatter = new JsBeautifyFormatter();
    const code = 'const a = 1;\nconst b = a + 1;\nconsole.log(b);';
    const formatted = formatter.format(code);

    expect(formatted).toContain('const a = 1;');
    expect(formatted).toContain('const b = a + 1;');
    expect(formatted).toContain('console.log(b);');
  });
});
