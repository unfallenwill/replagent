import type { LlmMessage, LlmRole } from './ports/llm.js';

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

  append(role: LlmRole, text: string): void {
    if (text.length === 0) {
      return;
    }
    const last = this.#messages.at(-1);
    if (last !== undefined && last.role === role) {
      this.#messages[this.#messages.length - 1] = { role, text: `${last.text}\n\n${text}` };
      return;
    }
    this.#messages.push({ role, text });
  }

  reset(): void {
    this.#messages.length = 0;
  }
}
