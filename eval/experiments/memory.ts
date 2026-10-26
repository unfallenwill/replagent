import type { Conversation } from '../../src/domain/conversation.js';
import type { UiEvent } from '../../src/domain/ports/ui.js';
import { formatQueue } from '../../src/domain/queue.js';

export const MEMORY_HELP: string = [
  'Optional harness available inside step: harness.state() reports conversation size;',
  'harness.checkpoint(summary) replaces earlier conversation with your summary after this unit succeeds.',
  'All original human requests are retained verbatim. Files, REPL globals, modules, and pending observations remain.',
  'Include decisions, verification, unfinished work, and important state in the summary.',
  'This does not finish the turn: still use deposit for observations or say after completion.',
].join(' ');

interface MemoryApi {
  state(): { messages: number; characters: number; checkpoints: number };
  checkpoint(summary: string): { queued: true };
}

/** Experimental memory, invoked by the model. Never synthesizes user requirements. */
export class MemoryController {
  readonly #conversation: Conversation;
  readonly #emit: (event: UiEvent) => void;
  readonly #humans: string[] = [];
  #token = 0;
  #active = false;
  #pending: string | undefined;
  #checkpoints = 0;

  constructor(conversation: Conversation, emit: (event: UiEvent) => void) {
    this.#conversation = conversation;
    this.#emit = emit;
  }

  remember(text: string): void {
    this.#humans.push(text);
  }

  begin(): number {
    this.#pending = undefined;
    this.#active = true;
    return ++this.#token;
  }

  bind(token: number): MemoryApi {
    return {
      state: () => {
        this.#assertActive(token);
        return {
          messages: this.#conversation.messages.length,
          characters: this.#characters(),
          checkpoints: this.#checkpoints,
        };
      },
      checkpoint: (summary) => {
        this.#assertActive(token);
        if (typeof summary !== 'string' || summary.trim().length === 0 || summary.length > 12_000) {
          throw new Error('checkpoint needs a nonempty summary of at most 12000 characters.');
        }
        this.#pending = summary;
        return { queued: true };
      },
    };
  }

  finish(success: boolean): void {
    this.#active = false;
    const summary = this.#pending;
    this.#pending = undefined;
    if (!success || summary === undefined) return;
    const before = this.#characters();
    this.#conversation.reset();
    this.#conversation.append(
      'user',
      formatQueue([
        ...this.#humans.map((text) => ({ origin: 'human' as const, text })),
        { origin: 'model', text: `Model checkpoint: ${summary}\n${MEMORY_HELP}` },
      ]),
    );
    this.#checkpoints++;
    this.#emit({
      type: 'status',
      text: `harness.checkpoint applied ${JSON.stringify({ count: this.#checkpoints, before, after: this.#characters() })}`,
    });
  }

  #assertActive(token: number): void {
    if (!this.#active || token !== this.#token) throw new Error('Expired harness execution.');
  }

  #characters(): number {
    return this.#conversation.messages.reduce(
      (sum, message) =>
        sum +
        message.text.length +
        (message.thinking?.reduce((n, block) => n + block.text.length, 0) ?? 0),
      0,
    );
  }
}
