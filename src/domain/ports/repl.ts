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
  /** The step that ran, if the code was a step. */
  readonly step: ReplStep | undefined;
}

/**
 * A step the agent named and described before it ran.
 */
export interface ReplStep {
  /** The handle the agent gave the step. */
  readonly name: string;
  /** What the step was for. */
  readonly description: string;
}

export interface ReplPort {
  /**
   * Run the code and report what happened.
   *
   * `onStep` is called the moment the code names its step, which is before
   * the step's body runs: the observer learns what is being done while it
   * is being done, not after.
   */
  exec(code: string, onStep?: (step: ReplStep) => void): Promise<ReplObservation>;
}
