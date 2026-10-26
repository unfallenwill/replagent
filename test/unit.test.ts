import { describe, expect, it } from 'vitest';
import {
  MISSING_BODY,
  MISSING_DESCRIPTION,
  MISSING_NAME,
  NOT_A_UNIT,
  scanUnit,
} from '../src/domain/unit.js';

describe('scanUnit', () => {
  it('accepts a unit with a name, a description and a program', () => {
    const scan = scanUnit(
      'await step("count the files", "read the dir and count what is in it", async (name, description) => { ... });',
    );
    expect(scan.ok).toBe(true);
    expect(scan.problem).toBeUndefined();
  });

  it('accepts a unit whose body is a named function', () => {
    const scan = scanUnit(
      'async function work() { return 1; }\nawait step("count", "count the files", work);',
    );
    expect(scan.ok).toBe(true);
  });

  it('rejects a reply that calls no step at all', () => {
    const scan = scanUnit('const entries = await fs.promises.readdir("src");');
    expect(scan.ok).toBe(false);
    expect(scan.problem).toBe(NOT_A_UNIT);
  });

  it('rejects a reply that carries two units', () => {
    const scan = scanUnit(
      'await step("one", "the first", async () => {});\nawait step("two", "the second", async () => {});',
    );
    expect(scan.ok).toBe(false);
    expect(scan.problem).toContain('2 units');
  });

  it('rejects a unit with no name', () => {
    const scan = scanUnit('await step(undefined, "what it does", async () => {});');
    expect(scan.ok).toBe(false);
    expect(scan.problem).toBe(MISSING_NAME);
  });

  it('rejects a unit with no description', () => {
    const scan = scanUnit('await step("count the files", undefined, async () => {});');
    expect(scan.ok).toBe(false);
    expect(scan.problem).toBe(MISSING_DESCRIPTION);
  });

  it('rejects a unit with nothing to run', () => {
    const scan = scanUnit('await step("count the files", "count what is in the dir");');
    expect(scan.ok).toBe(false);
    expect(scan.problem).toBe(MISSING_BODY);
  });

  it('rejects a unit whose program is nothing', () => {
    const scan = scanUnit('await step("count the files", "count what is in the dir", undefined);');
    expect(scan.ok).toBe(false);
    expect(scan.problem).toBe(MISSING_BODY);
  });

  it('rejects a description that is not a string', () => {
    const scan = scanUnit('await step("count the files", null, async () => {});');
    expect(scan.ok).toBe(false);
    expect(scan.problem).toBe(MISSING_DESCRIPTION);
  });

  it('rejects a name that is only whitespace', () => {
    const scan = scanUnit('await step("   ", "count what is in the dir", async () => {});');
    expect(scan.ok).toBe(false);
    expect(scan.problem).toBe(MISSING_NAME);
  });

  it('rejects a description that is only whitespace', () => {
    const scan = scanUnit('await step("count", "\\n  ", async () => {});');
    expect(scan.ok).toBe(false);
    expect(scan.problem).toBe(MISSING_DESCRIPTION);
  });

  it('does not mistake a step in a string for a call', () => {
    const scan = scanUnit('const note = "step(\\"a\\", \\"b\\", fn)";');
    expect(scan.ok).toBe(false);
    expect(scan.problem).toBe(NOT_A_UNIT);
  });

  it('does not mistake a step in a comment for a call', () => {
    const scan = scanUnit('// step("a", "b", fn)\nconst x = 1;');
    expect(scan.ok).toBe(false);
    expect(scan.problem).toBe(NOT_A_UNIT);
  });

  it('does not mistake a step in a template for a call', () => {
    const scan = scanUnit('const note = `step("a", "b", fn)`;');
    expect(scan.ok).toBe(false);
    expect(scan.problem).toBe(NOT_A_UNIT);
  });

  it('does not mistake a step in a regular expression for a call', () => {
    const scan = scanUnit('const pattern = /step\\("a", "b", fn\\)/;');
    expect(scan.ok).toBe(false);
    expect(scan.problem).toBe(NOT_A_UNIT);
  });

  it('does not mistake a member access for the repl step', () => {
    const scan = scanUnit('await helper.step("a", "b", fn);');
    expect(scan.ok).toBe(false);
    expect(scan.problem).toBe(NOT_A_UNIT);
  });

  it('does not mistake a declaration for a call', () => {
    const scan = scanUnit('function step(name, description, body) { return body(); }');
    expect(scan.ok).toBe(false);
    expect(scan.problem).toBe(NOT_A_UNIT);
  });

  it('accepts a name written as a template literal', () => {
    const scan = scanUnit('await step(`count the files`, `read the dir`, async () => {});');
    expect(scan.ok).toBe(true);
  });

  it('accepts a name that is computed, and leaves it to the repl to check', () => {
    const scan = scanUnit('await step(makeName(), "count what is in the dir", async () => {});');
    expect(scan.ok).toBe(true);
  });

  it('reads a name through its escapes', () => {
    const scan = scanUnit('await step("count \\u0074he files", "count", async () => {});');
    expect(scan.ok).toBe(true);
  });

  it('finds a call whose parenthesis is on the next line', () => {
    const scan = scanUnit('await step\n  ("count", "count the files", async () => {});');
    expect(scan.ok).toBe(true);
  });

  it('is not fooled by a division after a value', () => {
    const scan = scanUnit('const half = total / 2;\nawait step("count", "count", async () => {});');
    expect(scan.ok).toBe(true);
  });

  it('is not fooled by a regular expression that looks like division', () => {
    const scan = scanUnit(
      'const pattern = /a\\/b/g;\nawait step("count", "count the files", async () => {});',
    );
    expect(scan.ok).toBe(true);
  });

  it('counts the arguments of a call with a nested object', () => {
    const scan = scanUnit(
      'await step("count", "count the files", async () => { const opts = { a: 1, b: 2 }; });',
    );
    expect(scan.ok).toBe(true);
  });
});
