/**
 * The agent's model of the world.
 *
 * Two kinds of thing live in it, and keeping them apart is the whole
 * point: a fact is something that was observed, a belief is something that
 * was concluded. Both remember where they came from and when, because the
 * world keeps moving and a belief that was true an hour ago may not be.
 */
export interface WorldFact {
  /** What was observed. */
  readonly value: unknown;
  /** Where it came from: "readdir src", "GET /api/health", a command. */
  readonly source: string;
  /** When it was observed, ISO 8601. */
  readonly at: string;
}

export interface WorldBelief extends WorldFact {
  /** How sure the agent is, from 0 to 1. */
  readonly confidence: number;
}

/**
 * What the agent is doing right now.
 *
 * The name is the handle the agent gave the step, the description is what
 * the step is for. Both come from the agent, before the step runs.
 */
export interface WorldPlan {
  /** The handle the agent gave the step. */
  readonly name: string;
  /** What the step is for. */
  readonly description: string;
}

export interface WorldState {
  /** What was observed, by name. */
  readonly facts: Readonly<Record<string, WorldFact>>;
  /** What was concluded, by name. */
  readonly beliefs: Readonly<Record<string, WorldBelief>>;
  /** What the agent is doing right now. */
  readonly plan: WorldPlan | undefined;
}

export interface WorldPort {
  /** The model as it is now. */
  read(): WorldState;
  /**
   * Keep the model.
   *
   * It has to outlive the process that produced it, or it is not a memory:
   * the agent's observations and conclusions are worth more than the
   * session that happened to make them.
   */
  write(state: WorldState): void;
}
