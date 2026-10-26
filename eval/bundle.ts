import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash } from './files.js';

/** Include local static dependencies, so a helper edit changes the candidate identity. */
export async function candidateHash(entry: string): Promise<string> {
  const files = new Map<string, string>();
  await collect(entry, files);
  return hash(
    [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, content]) => `${path.relative(path.dirname(entry), file)}\n${content}`)
      .join('\n'),
  );
}

async function collect(file: string, files: Map<string, string>): Promise<void> {
  if (files.has(file)) return;
  const content = await readFile(file, 'utf8');
  files.set(file, content);
  const imports = content.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g);
  for (const match of imports) {
    const specifier = match[1];
    if (specifier === undefined || !specifier.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts'));
    if (target.endsWith('.ts')) await collect(target, files);
  }
}
