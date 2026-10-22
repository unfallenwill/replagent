import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  WorldBelief,
  WorldFact,
  WorldPlan,
  WorldPort,
  WorldState,
} from '../../domain/ports/world.js';
import { emptyWorld } from '../../domain/world.js';

/**
 * The world model, kept in a file.
 *
 * A file rather than memory, because a model that dies with the process is
 * not a model of anything: the agent's observations and conclusions have to
 * outlive the session that produced them, and the human has to be able to
 * open the file and read what the agent believes.
 */
export class FileWorld implements WorldPort {
  readonly #path: string;

  constructor(filePath: string) {
    this.#path = path.resolve(filePath);
  }

  /** Where the model is kept. */
  get path(): string {
    return this.#path;
  }

  read(): WorldState {
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch {
      // No model yet is not a failure: the agent has not written one.
      return emptyWorld();
    }

    try {
      return parseWorld(JSON.parse(raw));
    } catch {
      // A file the agent itself can write to can hold anything. A model
      // that cannot be read is no model; start over rather than crash.
      return emptyWorld();
    }
  }

  write(state: WorldState): void {
    mkdirSync(path.dirname(this.#path), { recursive: true });
    // Write and rename: a half written file is worse than no file, because
    // the agent would read it back as a corrupt model.
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.#path);
  }
}

/**
 * Read a model out of a file that anything could have written to it.
 *
 * Everything that does not look like what it should be is dropped: a model
 * with a hole in it is still a model, a model that throws is not.
 */
function parseWorld(raw: unknown): WorldState {
  if (typeof raw !== 'object' || raw === null) {
    return emptyWorld();
  }

  const record = raw as Record<string, unknown>;

  return {
    facts: readEntries(record['facts'], asFact),
    beliefs: readEntries(record['beliefs'], asBelief),
    plan: asPlan(record['plan']),
  };
}

function asPlan(raw: unknown): WorldPlan | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }

  const plan = raw as Record<string, unknown>;
  const name = plan['name'];
  const description = plan['description'];
  if (typeof name !== 'string' || typeof description !== 'string') {
    return undefined;
  }
  return { name, description };
}

function readEntries<T>(raw: unknown, read: (entry: unknown) => T | undefined): Record<string, T> {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }

  const entries: Record<string, T> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const value = read(entry);
    if (value !== undefined) {
      entries[name] = value;
    }
  }
  return entries;
}

function asFact(raw: unknown): WorldFact | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }

  const entry = raw as Record<string, unknown>;
  const source = entry['source'];
  const at = entry['at'];
  if (typeof source !== 'string' || typeof at !== 'string') {
    return undefined;
  }
  return { value: entry['value'], source, at };
}

function asBelief(raw: unknown): WorldBelief | undefined {
  const fact = asFact(raw);
  if (fact === undefined) {
    return undefined;
  }

  const confidence = (raw as Record<string, unknown>)['confidence'];
  if (typeof confidence !== 'number') {
    return undefined;
  }
  return { ...fact, confidence };
}
