import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from './files.js';
import type { EvalTask } from './types.js';

/** Offline, private dependency copy. Neither credentials nor the host .env are copied. */
export async function prepareWorkspace(
  task: EvalTask,
  cwd: string,
  artifacts: string,
): Promise<void> {
  if (task.setup === undefined) return;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const expected = task.setup.lockHash;
  for (const file of [path.join(root, 'package-lock.json'), path.join(cwd, 'package-lock.json')]) {
    if (hash(await readFile(file, 'utf8')) !== expected)
      throw new Error('Dependency lock mismatch. Run npm ci for the pinned task snapshot.');
  }
  const started = performance.now();
  await cp(path.join(root, 'node_modules'), path.join(cwd, 'node_modules'), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  await writeFile(
    path.join(artifacts, 'setup.json'),
    JSON.stringify(
      {
        type: 'private-dependency-copy',
        lockHash: expected,
        installedLockHash: hash(
          await readFile(path.join(root, 'node_modules/.package-lock.json'), 'utf8'),
        ),
        wallMs: Math.round(performance.now() - started),
      },
      null,
      2,
    ),
  );
}
