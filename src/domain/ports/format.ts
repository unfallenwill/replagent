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
