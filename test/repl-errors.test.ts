import { describe, expect, it } from 'vitest';
import { explainReplError } from '../src/domain/repl-errors.js';

describe('explainReplError', () => {
  it('explains a redeclaration', () => {
    const note = explainReplError(
      "Uncaught SyntaxError: Identifier 'response' has already been declared",
    );

    expect(note?.note).toContain("'response'");
    expect(note?.note).toContain('Assign to the existing binding');
  });

  it('stays quiet for errors that are already clear', () => {
    expect(explainReplError('Cannot find module "node:nope"')).toBeUndefined();
  });
});
