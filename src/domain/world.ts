import type { WorldBelief, WorldFact, WorldPlan, WorldState } from './ports/world.js';

/**
 * The transitions of the world model.
 *
 * They are pure: the state in, the next state out. The agent's model is
 * only ever replaced by a new one, so a reader can always tell what the
 * model was before a change and what it is after.
 */

export function emptyWorld(): WorldState {
  return { facts: {}, beliefs: {}, plan: undefined };
}

/** Record something that was observed. A second observation replaces the first. */
export function addFact(
  state: WorldState,
  name: string,
  value: unknown,
  source: string,
  at: string,
): WorldState {
  const fact: WorldFact = { value, source, at };
  return { ...state, facts: { ...state.facts, [name]: fact } };
}

/** Record something that was concluded, and how sure the agent is of it. */
export function addBelief(
  state: WorldState,
  name: string,
  value: unknown,
  confidence: number,
  basis: string,
  at: string,
): WorldState {
  const belief: WorldBelief = {
    value,
    source: basis,
    at,
    confidence: Math.min(1, Math.max(0, confidence)),
  };
  return { ...state, beliefs: { ...state.beliefs, [name]: belief } };
}

/** Say what happens next. */
export function setPlan(state: WorldState, plan: WorldPlan): WorldState {
  return { ...state, plan };
}

/**
 * The model as text.
 *
 * The agent reads its own model, and so does the human when they open the
 * file. An object would be truncated on the way out - the console shows two
 * levels and the model is deeper than that - so the model is written out
 * flat, one line per thing.
 */
export function formatWorld(state: WorldState): string {
  const lines: string[] = [];

  const facts = Object.entries(state.facts);
  lines.push(facts.length === 0 ? 'facts: none' : 'facts:');
  for (const [name, fact] of facts) {
    lines.push(`  ${name} = ${describe(fact.value)} (${fact.source}, ${fact.at})`);
  }

  const beliefs = Object.entries(state.beliefs);
  lines.push(beliefs.length === 0 ? 'beliefs: none' : 'beliefs:');
  for (const [name, belief] of beliefs) {
    lines.push(
      `  ${name} = ${describe(belief.value)}, confidence ${belief.confidence} ` +
        `(${belief.source}, ${belief.at})`,
    );
  }

  lines.push(state.plan === undefined ? 'plan: none' : `plan: ${describePlan(state.plan)}`);

  return lines.join('\n');
}

function describePlan(plan: WorldPlan): string {
  return plan.name.length === 0 ? plan.description : `${plan.name} - ${plan.description}`;
}

function describe(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
