/**
 * The only sensory organ of the agent.
 *
 * Every turn the agent writes JavaScript; the REPL runs it and reports back
 * what happened: what was logged, what the last expression evaluated to, and
 * whether it blew up. Nothing else reaches the agent.
 */

export interface ReplObservation {
  /** True when the code ran to completion without throwing. */
  readonly ok: boolean;
  /** Everything the code wrote through `console`. */
  readonly logs: readonly string[];
  /** Rendered value of the last expression, if the code produced one. */
  readonly value: string | undefined;
  /** Error text when the code failed (syntax, runtime or uncaught). */
  readonly error: string | undefined;
  /** Set when the code called `finish(...)` to end the turn. */
  readonly finalAnswer: string | undefined;
}

export interface ReplPort {
  exec(code: string): Promise<ReplObservation>;
}
