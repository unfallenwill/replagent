/**
 * The only sensory organ of the agent.
 *
 * Every turn the agent writes one unit of JavaScript; the REPL runs it and
 * reports back what happened. There are four things that can happen inside a
 * unit, and each of them is an event:
 *
 *   - the unit names itself, before its body runs;
 *   - a tool runs, with the reason it was called;
 *   - the agent says something to the human;
 *   - the agent deposits something for the model to read next.
 *
 * There is nothing else. A unit has no return value to read, no console to
 * print to and no way to end the turn on its own: `say` is the only way out,
 * and `deposit` is the only way to talk back to the model.
 */

/** A step the agent named and described before it ran. */
export interface ReplStep {
  /** The handle the agent gave the step. */
  readonly name: string;
  /** What the step was for. */
  readonly description: string;
}

/** What happened while the unit ran. */
export type ReplEvent =
  /** The unit named itself. This arrives before the body runs. */
  | { readonly kind: 'step'; readonly name: string; readonly description: string }
  /** A tool ran: what it was, why it was called, and what came of it. */
  | {
      readonly kind: 'tool';
      readonly tool: string;
      readonly intent: string;
      readonly detail: string;
    }
  /** The agent said something to the human. The first one ends the round. */
  | { readonly kind: 'say'; readonly text: string }
  /** The agent deposited something for the model to read next. */
  | { readonly kind: 'deposit'; readonly text: string };

/** What came of one unit. */
export interface ReplOutcome {
  /** True when the unit ran to the end without throwing. */
  readonly ok: boolean;
  /** The error it threw, when it threw. */
  readonly error: string | undefined;
  /** The step that ran, when one did. */
  readonly step: ReplStep | undefined;
  /** True when the agent spoke to the human: the round is over. */
  readonly said: boolean;
}

export interface ReplPort {
  /**
   * Run one unit and report what happened.
   *
   * The events arrive while the unit runs, not after it: the human sees the
   * step's name while the step is still working.
   */
  exec(code: string, onEvent?: (event: ReplEvent) => void): Promise<ReplOutcome>;
}
