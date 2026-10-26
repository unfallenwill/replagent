import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installFixtures, snapshot, workspacePath } from './files.js';
import { grade } from './graders.js';
import type { Answer, CheckResult, EvalCheck, EvalTask } from './types.js';

/** A turn boundary pauses the subject until its workspace has been copied. */
export class Checkpoints {
  readonly #captured = new Map<number, string>();
  readonly task: EvalTask;
  readonly workspace: string;
  readonly directory: string;
  readonly copies: string;

  constructor(task: EvalTask, workspace: string, directory: string, copies: string) {
    this.task = task;
    this.workspace = workspace;
    this.directory = directory;
    this.copies = copies;
  }

  async prepare(turn: number): Promise<void> {
    for (const update of this.task.updates ?? []) {
      if (update.beforeTurn === turn) await installFixtures(this.workspace, update.files);
    }
  }

  async capture(turn: number): Promise<void> {
    if (
      !this.task.checks.some(
        (check) =>
          check.afterTurn === turn || (check.type === 'unchanged' && check.sinceTurn === turn),
      )
    )
      return;
    const target = path.join(this.copies, String(turn));
    await cp(this.workspace, target, { recursive: true, dereference: false });
    this.#captured.set(turn, target);
    const directory = path.join(this.directory, 'checkpoints');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${turn}.json`),
      JSON.stringify(await snapshot(target), null, 2),
    );
  }

  /** All hidden checks run after the subject process has been stopped. */
  async grade(answers: readonly Answer[]): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];
    for (const check of this.task.checks) {
      const cwd =
        check.afterTurn === undefined ? this.workspace : this.#captured.get(check.afterTurn);
      if (cwd === undefined) {
        checks.push({
          id: check.id,
          passed: false,
          detail: 'User turn checkpoint was not reached.',
        });
      } else {
        checks.push(...(await this.#grade(check, cwd, answers)));
      }
    }
    return checks;
  }

  async #grade(check: EvalCheck, cwd: string, answers: readonly Answer[]): Promise<CheckResult[]> {
    try {
      let resolved = check;
      if (check.type === 'unchanged' && check.sinceTurn !== undefined) {
        const before = this.#captured.get(check.sinceTurn);
        if (before === undefined) throw new Error('Source user turn checkpoint was not reached.');
        const content = await readFile(workspacePath(before, check.path), 'utf8');
        resolved = { id: check.id, type: 'file', path: check.path, content };
      }
      return await grade({ ...this.task, checks: [resolved] }, cwd, answers);
    } catch (error) {
      return [{ id: check.id, passed: false, detail: String(error) }];
    }
  }
}
