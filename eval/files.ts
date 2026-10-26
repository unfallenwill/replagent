import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EvalTask } from './types.js';

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function taskHash(task: EvalTask): string {
  const { reference: _reference, ...definition } = task;
  return hash(JSON.stringify(definition));
}

/** Fixture and grader paths must stay inside the workspace. */
export function workspacePath(cwd: string, relative: string): string {
  const target = path.resolve(cwd, relative);
  const remainder = path.relative(cwd, target);
  if (remainder === '' || remainder.startsWith('..') || path.isAbsolute(remainder)) {
    throw new Error(`Expected a workspace-relative file path: ${relative}`);
  }
  return target;
}

export async function installFixtures(cwd: string, fixtures: EvalTask['fixtures']): Promise<void> {
  for (const [relative, content] of Object.entries(fixtures)) {
    const target = workspacePath(cwd, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

export async function sourceHash(root: string): Promise<string> {
  const files = await sourceFiles(path.join(root, 'src'));
  const contents = await Promise.all(
    files
      .sort()
      .map(async (file) => `${path.relative(root, file)}\n${await readFile(file, 'utf8')}`),
  );
  return hash(contents.join('\n'));
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(target)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(target);
    }
  }
  return files;
}

/** Bounded final-state evidence; never follow links out of the trial. */
export async function snapshot(cwd: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const pending = ['.'];
  while (pending.length > 0 && Object.keys(result).length < 200) {
    const directory = pending.pop() as string;
    await snapshotDirectory(cwd, directory, pending, result);
  }
  return result;
}

async function snapshotDirectory(
  cwd: string,
  relative: string,
  pending: string[],
  result: Record<string, unknown>,
): Promise<void> {
  for (const entry of await readdir(path.join(cwd, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) {
      result[name] = { omitted: 'symbolic link' };
    } else if (entry.isDirectory()) {
      if (!['node_modules', '.git'].includes(entry.name)) {
        pending.push(name);
      }
    } else if (entry.isFile()) {
      const file = path.join(cwd, name);
      const size = (await stat(file)).size;
      result[name] =
        size <= 200_000
          ? { content: await readFile(file, 'utf8'), size }
          : { omitted: 'large', size };
    }
    if (Object.keys(result).length >= 200) {
      result['$truncated'] = true;
      return;
    }
  }
}
