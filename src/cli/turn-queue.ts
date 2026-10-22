/**
 * Serialises the turns of the agent.
 *
 * The human can type while the agent is working. Those messages have to be
 * queued, not dropped and not run in parallel: two turns sharing one REPL
 * would interleave their observations.
 */
export class TurnQueue {
  readonly #pending: string[] = [];
  readonly #handler: (text: string) => Promise<void>;
  readonly #onError: (error: unknown) => void;
  #running = false;

  constructor(
    handler: (text: string) => Promise<void>,
    onError: (error: unknown) => void = () => {},
  ) {
    this.#handler = handler;
    this.#onError = onError;
  }

  /** Queue a message and start draining if nothing is running. */
  push(text: string): void {
    this.#pending.push(text);
    if (this.#running) {
      return;
    }
    this.#running = true;
    void this.#drain();
  }

  /** How many messages are still waiting. */
  get pending(): number {
    return this.#pending.length;
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending.length > 0) {
        const next = this.#pending.shift();
        if (next === undefined) {
          break;
        }
        try {
          await this.#handler(next);
        } catch (error) {
          // A failing turn must not strand the messages behind it.
          this.#onError(error);
        }
      }
    } finally {
      this.#running = false;
    }
  }
}
