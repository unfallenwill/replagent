import type { WorldPort, WorldState } from '../../domain/ports/world.js';
import { emptyWorld } from '../../domain/world.js';

/**
 * A world model that lives only as long as the process does.
 *
 * Useful when a session should start from nothing: a fresh task, a test, a
 * human who wants the agent to forget what it thought last time.
 */
export class MemoryWorld implements WorldPort {
  #state: WorldState = emptyWorld();

  read(): WorldState {
    return this.#state;
  }

  write(state: WorldState): void {
    this.#state = state;
  }
}
