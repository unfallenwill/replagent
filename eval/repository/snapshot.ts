import { readFileSync } from 'node:fs';
import { hash } from '../files.js';

interface RepositorySnapshot {
  readonly commit: string;
  readonly contentHash: string;
  readonly fixtures: Readonly<Record<string, string>>;
}

export const SNAPSHOT: RepositorySnapshot = JSON.parse(
  readFileSync(new URL('./snapshot.json', import.meta.url), 'utf8'),
) as RepositorySnapshot;
if (hash(JSON.stringify(SNAPSHOT.fixtures)) !== SNAPSHOT.contentHash)
  throw new Error('Repository snapshot fingerprint mismatch.');
