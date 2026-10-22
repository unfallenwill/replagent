/**
 * What the outside world sees of the agent.
 *
 * The agent lives inside the REPL; the terminal is the only window we have
 * into it. The UI is a pure event sink plus one input channel.
 */

export type UiEvent =
  /** Something the human typed. */
  | { readonly type: 'user-message'; readonly text: string }
  /** A chunk of the JavaScript the agent is currently writing. */
  | { readonly type: 'agent-code-delta'; readonly text: string }
  /** The complete JavaScript of one turn. */
  | { readonly type: 'agent-code'; readonly text: string }
  /** A line the agent's code logged. */
  | { readonly type: 'repl-log'; readonly text: string }
  /** The value the agent's last expression evaluated to. */
  | { readonly type: 'repl-value'; readonly text: string }
  /** The agent's code failed. */
  | { readonly type: 'repl-error'; readonly text: string }
  /** The agent called `finish(...)`. */
  | { readonly type: 'final'; readonly text: string }
  /** Neutral information about the run (limits, truncation, retries). */
  | { readonly type: 'status'; readonly text: string };

export interface UiPort {
  emit(event: UiEvent): void;
  /** Register the handler that receives human input. */
  onInput(handler: (text: string) => void): void;
  /** Run until the human leaves. */
  run(): Promise<void>;
  stop(): void;
}
