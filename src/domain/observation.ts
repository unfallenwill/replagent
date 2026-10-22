import type { ReplObservation } from './ports/repl.js';

/**
 * The marker that separates what the REPL returns from what the human says.
 *
 * Without it the observation arrives as a plain user turn, and the model has
 * no way to tell "the human asked something" from "the machine answered" -
 * so it drifts back into being a chat assistant that happens to emit
 * JavaScript.
 */
export const OBSERVATION_OPEN = '<observation>';
export const OBSERVATION_CLOSE = '</observation>';

/**
 * Turn an observation into the text the agent reads back.
 *
 * The observation is the agent's entire sensory input, so it has to be
 * unambiguous: the agent must be able to tell logs, results and errors apart
 * without guessing, and it must be able to tell that this text did not come
 * from the human.
 */
export function formatObservation(observation: ReplObservation): string {
  const parts: string[] = [];

  for (const log of observation.logs) {
    parts.push(log);
  }
  if (observation.value !== undefined) {
    parts.push(`=> ${observation.value}`);
  }
  if (observation.error !== undefined) {
    parts.push(`ERROR: ${observation.error}`);
  }
  if (parts.length === 0) {
    parts.push('(no output)');
  }

  return `${OBSERVATION_OPEN}\n${parts.join('\n')}\n${OBSERVATION_CLOSE}`;
}
