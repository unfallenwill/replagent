/**
 * Formatting is a display concern, not an execution one.
 *
 * The code that runs is exactly what the model wrote. The formatted version
 * only ever appears in the transcript, where the human reads the agent's
 * thoughts.
 */
export interface CodeFormatter {
  /** Pretty-print JavaScript. Must never throw: on failure, return the input. */
  format(code: string): string;
}

/**
 * Colouring is a display concern too, and it happens after formatting, so
 * the colours land on the columns the human is reading.
 */
export interface CodeHighlighter {
  /**
   * Colour JavaScript for the terminal.
   *
   * Must never throw: on failure, return the input unchanged.
   */
  highlight(code: string): string;
}
