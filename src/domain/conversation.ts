import type { LlmMessage, LlmRole, LlmThinkingBlock } from './ports/llm.js';

/**
 * The agent's memory of what happened.
 *
 * The Anthropic API expects alternating user/assistant turns, but the agent
 * loop produces an observation right after every assistant turn, so two user
 * messages can end up back to back (for example when a turn both logs and
 * finishes). Merging keeps the transcript valid without losing anything.
 */
export class Conversation {
  readonly #messages: LlmMessage[] = [];

  get messages(): readonly LlmMessage[] {
    return this.#messages;
  }

  /**
   * Adds one turn. The reasoning travels with the assistant turn it produced:
   * the model is expected to see its own thoughts again on the next request,
   * so a turn's thinking is kept exactly as it arrived.
   */
  append(role: LlmRole, text: string, thinking?: readonly LlmThinkingBlock[]): void {
    if (text.length === 0) {
      return;
    }
    const added = thinking?.length ? thinking : undefined;
    const last = this.#messages.at(-1);
    if (last !== undefined && last.role === role) {
      this.#messages[this.#messages.length - 1] = mergeTurns(last, text, added);
      return;
    }
    this.#messages.push({ role, text, ...(added !== undefined ? { thinking: added } : {}) });
  }

  reset(): void {
    this.#messages.length = 0;
  }
}

/** Extends one turn with another of the same role, reasoning included. */
function mergeTurns(
  last: LlmMessage,
  text: string,
  added: readonly LlmThinkingBlock[] | undefined,
): LlmMessage {
  const thinking =
    last.thinking !== undefined && added !== undefined
      ? [...last.thinking, ...added]
      : (last.thinking ?? added);
  return {
    role: last.role,
    text: `${last.text}\n\n${text}`,
    ...(thinking !== undefined ? { thinking } : {}),
  };
}
