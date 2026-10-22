/**
 * Explaining what went wrong inside the REPL.
 *
 * The REPL is the agent's memory, which means the mistakes a human makes
 * once a day are the mistakes an agent makes every turn: declaring the same
 * `const` twice. The raw error is correct REPL behaviour but useless as
 * feedback, so it gets a note that says what to do instead.
 */

const REDECLARED = /Identifier '([^']+)' has already been declared/;

export interface ReplErrorNote {
  /** The explanation to hand back to the agent. */
  readonly note: string;
}

/**
 * Return a note for the errors an agent runs into over and over, or
 * `undefined` when the raw error is already clear enough.
 */
export function explainReplError(error: string): ReplErrorNote | undefined {
  const redeclared = REDECLARED.exec(error)?.[1];
  if (redeclared !== undefined) {
    return {
      note:
        `You already declared '${redeclared}' in an earlier turn, and the REPL keeps ` +
        `its declarations - that is how you remember things. Assign to the existing ` +
        `binding instead of declaring it again, or pick a different name.`,
    };
  }

  return undefined;
}
