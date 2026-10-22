import { afterEach, describe, expect, it } from 'vitest';
import { NodeReplSession } from '../src/adapters/repl/node-repl.js';

const sessions: NodeReplSession[] = [];

function session(): NodeReplSession {
  const created = new NodeReplSession({ cwd: process.cwd() });
  sessions.push(created);
  return created;
}

afterEach(() => {
  while (sessions.length > 0) {
    sessions.pop()?.close();
  }
});

describe('NodeReplSession', () => {
  it('runs code and returns the value of the last expression', async () => {
    const repl = session();
    const observation = await repl.exec('1 + 1');

    expect(observation.ok).toBe(true);
    expect(observation.value).toBe('2');
    expect(observation.error).toBeUndefined();
  });

  it('keeps state between calls', async () => {
    const repl = session();
    await repl.exec('const remembered = "still here"');
    const observation = await repl.exec('remembered');

    expect(observation.value).toBe("'still here'");
  });

  it('supports top level await', async () => {
    const repl = session();
    const observation = await repl.exec('const value = await Promise.resolve(7); value * 6');

    expect(observation.ok).toBe(true);
    expect(observation.value).toBe('42');
  });

  it('captures console output', async () => {
    const repl = session();
    const observation = await repl.exec('console.log("hello", 42)');

    expect(observation.logs).toEqual(['hello 42']);
  });

  it('reports runtime errors without dying', async () => {
    const repl = session();
    const observation = await repl.exec('throw new Error("boom")');

    expect(observation.ok).toBe(false);
    expect(observation.error).toContain('boom');

    const after = await repl.exec('1 + 1');
    expect(after.value).toBe('2');
  });

  it('reports syntax errors', async () => {
    const repl = session();
    const observation = await repl.exec('function broken( {');

    expect(observation.ok).toBe(false);
    expect(observation.error).toContain('SyntaxError');
  });

  it('captures the answer of finish()', async () => {
    const repl = session();
    const observation = await repl.exec('finish("the answer")');

    expect(observation.finalAnswer).toBe('the answer');
  });

  it('lets the first finish() win', async () => {
    const repl = session();
    const observation = await repl.exec('finish("first"); finish("second")');

    expect(observation.finalAnswer).toBe('first');
  });

  it('ignores a finish() that arrives late from an earlier turn', async () => {
    const repl = session();
    await repl.exec('globalThis.late = (f) => setTimeout(() => f("late"), 40); late(finish);');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const observation = await repl.exec('await new Promise((r) => setTimeout(r, 120)); "done"');

    expect(observation.value).toBe("'done'");
    expect(observation.finalAnswer).toBeUndefined();
  });
});
