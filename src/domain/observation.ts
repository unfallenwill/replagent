import type { ReplObservation } from './ports/repl.js';

/**
 * Turn an observation into the text the agent reads back.
 *
 * The observation is the agent's entire sensory input, so it has to be
 * unambiguous: the agent must be able to tell logs, results and errors apart
 * without guessing.
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

  return parts.join('\n');
}
