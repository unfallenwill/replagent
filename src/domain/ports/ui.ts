/**
 * What the outside world sees of the agent.
 *
 * The agent lives inside the REPL; the terminal is the only window we have
 * into it. The UI is a pure event sink plus one input channel.
 */

import type { LlmUsage } from './llm.js';

export type UiEvent =
  /** Something the human typed. */
  | { readonly type: 'user-message'; readonly text: string }
  /** A chunk of the JavaScript the agent is currently writing. */
  | { readonly type: 'agent-code-delta'; readonly text: string }
  /** The complete JavaScript of one turn. */
  | { readonly type: 'agent-code'; readonly text: string }
  /**
   * The reasoning that came before the reply. Arrives before `agent-code`,
   * because that is the order it happened in.
   */
  | { readonly type: 'agent-thinking'; readonly text: string }
  /**
   * A chunk of the reasoning, as it is being written. `chars` is how much
   * of it has arrived so far: the fold reports its size while it is still
   * being written.
   */
  | { readonly type: 'agent-thinking-delta'; readonly chars: number }
  /** The step that ran: the name the agent gave it and what it was for. */
  | { readonly type: 'step'; readonly name: string; readonly description: string }
  /**
   * A tool ran. The intent is the agent's own words about why it called the
   * tool, and it is the reason the toolkit asks for one.
   */
  | {
      readonly type: 'tool';
      readonly tool: string;
      readonly intent: string;
      readonly detail: string;
    }
  /**
   * The code finished running. Emitted even when the observation says
   * nothing, so the step's line can settle instead of spinning forever.
   */
  | { readonly type: 'exec-done' }
  /** What the agent said to the human. */
  | { readonly type: 'say'; readonly text: string }
  /** The agent's code failed. */
  | { readonly type: 'repl-error'; readonly text: string }
  /** Neutral information about the run (limits, truncation, retries). */
  | { readonly type: 'status'; readonly text: string }
  /** The agent started (or stopped) working on a turn. */
  | { readonly type: 'busy'; readonly busy: boolean }
  /**
   * How far the turn has got: steps done against the budget. Emitted once
   * at the start of a turn with zero steps, and once after each step.
   */
  | { readonly type: 'turn-progress'; readonly steps: number; readonly maxSteps: number }
  /** What the latest model call cost. Arrives when a reply completes. */
  | { readonly type: 'turn-usage'; readonly usage: LlmUsage };

export interface UiPort {
  emit(event: UiEvent): void;
  /** Register the handler that receives human input. */
  onInput(handler: (text: string) => void): void;
  /** Run until the human leaves. */
  run(): Promise<void>;
  stop(): void;
}
