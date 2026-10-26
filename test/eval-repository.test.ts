import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { candidateHash } from '../eval/bundle.js';
import { SNAPSHOT } from '../eval/repository/snapshot.js';
import { TASKS } from '../eval/repository/tasks.js';
import { validateTasks } from '../eval/tasks.js';
import { prepareWorkspace } from '../eval/workspace.js';
import { EVAL_ROOT, required } from './eval-fixtures.js';

let directory = '';
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'replagent-repository-test-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('pins a complete repository, original tests, and offline dependency identity without environment files', async () => {
  validateTasks(TASKS);
  expect(Object.keys(SNAPSHOT.fixtures)).toHaveLength(61);
  expect(Object.keys(SNAPSHOT.fixtures).some((file) => /(^|\/)\.env(?:\.|$)/.test(file))).toBe(
    false,
  );
  expect(SNAPSHOT.fixtures['src/adapters/repl/node-repl.ts']).toBeDefined();
  expect(SNAPSHOT.fixtures['test/agent.test.ts']).toBeDefined();
  expect(SNAPSHOT.fixtures['package-lock.json']).toBe(
    await readFile(path.join(EVAL_ROOT, 'package-lock.json'), 'utf8'),
  );
  expect(
    TASKS.every((task) => task.partition === 'holdout' && task.setup?.type === 'node-project'),
  ).toBe(true);
});

it('detects edits to a candidate dependency as well as its entry point', async () => {
  const entry = path.join(directory, 'entry.ts');
  await writeFile(entry, "export { value } from './helper.js';\n");
  await writeFile(path.join(directory, 'helper.ts'), 'export const value=1;');
  const before = await candidateHash(entry);
  await writeFile(path.join(directory, 'helper.ts'), 'export const value=2;');
  expect(await candidateHash(entry)).not.toBe(before);
});

it('rejects dependency drift before copying anything into a subject workspace', async () => {
  const task = required(TASKS[0]);
  await writeFile(path.join(directory, 'package-lock.json'), '{}');
  await expect(prepareWorkspace(task, directory, directory)).rejects.toThrow('lock mismatch');
  expect(() =>
    validateTasks([
      { ...task, checks: [{ id: 'bad-timeout', type: 'node', code: '', timeoutMs: Infinity }] },
    ]),
  ).toThrow('Invalid grader timeout');
});
