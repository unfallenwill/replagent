import { afterEach, describe, expect, it } from 'vitest';
import { NodeReplSession } from '../src/adapters/repl/node-repl.js';
import { MemoryWorld } from '../src/adapters/world/memory-world.js';

const sessions: NodeReplSession[] = [];

function session(): NodeReplSession {
  const created = new NodeReplSession({ cwd: process.cwd(), world: new MemoryWorld() });
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

  it('captures console output through the whole console api', async () => {
    const repl = session();
    const observation = await repl.exec(
      'console.log("%s items", 3); console.count("run"); console.table([{ a: 1 }]);',
    );

    expect(observation.logs[0]).toBe('3 items');
    expect(observation.logs[1]).toBe('run: 1');
    expect(observation.logs.join('\n')).toContain('a');
  });

  it('captures a multi line write as separate lines', async () => {
    const repl = session();
    const observation = await repl.exec('console.log("first\\nsecond")');

    expect(observation.logs).toEqual(['first', 'second']);
  });

  it('captures console errors', async () => {
    const repl = session();
    const observation = await repl.exec('console.error("broken")');

    expect(observation.logs).toEqual(['broken']);
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

  it('keeps a model of the world', async () => {
    const repl = session();
    await repl.exec('world.observe("module count", 4, "readdir src")');
    await repl.exec('world.believe("the build is broken", true, 0.6, "the tests failed")');
    await repl.exec('await step("check the build", "read the server log", async () => 1)');

    const observation = await repl.exec('console.log(world.report())');
    const report = observation.logs.join('\n');

    expect(report).toContain('module count = 4 (readdir src,');
    expect(report).toContain('the build is broken = true, confidence 0.6');
    expect(report).toContain('plan: check the build - read the server log');
  });

  it('keeps observations and conclusions apart in the model', async () => {
    const repl = session();
    await repl.exec('world.observe("module count", 4, "readdir src")');
    await repl.exec('world.believe("the build is broken", true, 0.6, "the tests failed")');

    const observation = await repl.exec('world.state()');

    expect(observation.value).toContain('module count');
    expect(observation.value).toContain('the build is broken');
  });

  it('runs a step and hands the body its name and description', async () => {
    const repl = session();
    const observation = await repl.exec(
      'await step("count the modules", "read src", async (name, description) => `${name}: ${description}`)',
    );

    expect(observation.value).toBe("'count the modules: read src'");
    expect(observation.step).toEqual({ name: 'count the modules', description: 'read src' });
  });

  it('keeps the step in the world model before the body runs', async () => {
    const repl = session();
    await repl.exec('await step("look around", "see what is here", async () => 1)');

    const observation = await repl.exec('world.state()');

    expect(observation.value).toContain('look around');
    expect(observation.value).toContain('see what is here');
  });

  it('refuses a step without a name', async () => {
    const repl = session();
    const observation = await repl.exec('await step("", "read src", async () => 1)');

    expect(observation.error).toContain('A step needs a name');
  });

  it('refuses a step without a description', async () => {
    const repl = session();
    const observation = await repl.exec('await step("count", "", async () => 1)');

    expect(observation.error).toContain('A step needs a description');
  });

  it('refuses a step without a program', async () => {
    const repl = session();
    const observation = await repl.exec('await step("count", "read src", 42)');

    expect(observation.error).toContain('A step needs a program');
  });

  it('waits for the promise a step hands back', async () => {
    const repl = session();
    const observation = await repl.exec(
      'await step("wait", "resolve later", async () => { await new Promise((r) => setTimeout(r, 10)); return "late"; })',
    );

    expect(observation.value).toBe("'late'");
  });

  it('gives every step a clean scope', async () => {
    const repl = session();
    await repl.exec(
      'await step("first", "declare a name", async () => { const scoped = 1; return scoped; })',
    );

    const observation = await repl.exec('scoped');

    expect(observation.error).toContain('scoped is not defined');
  });

  it('cuts a long line and says how much was cut', async () => {
    const repl = session();
    const observation = await repl.exec('console.log("x".repeat(30000))');

    expect(observation.logs[0]?.length).toBeLessThan(8100);
    expect(observation.logs[0]).toContain('more characters');
  });

  it('cuts a long value and says how much was cut', async () => {
    const repl = session();
    const observation = await repl.exec('"y".repeat(30000)');

    expect(observation.value?.length).toBeLessThan(8100);
    expect(observation.value).toContain('more characters');
  });

  it('leaves an ordinary exploration alone', async () => {
    const repl = session();
    const observation = await repl.exec(
      'console.log(JSON.stringify({ rows: new Array(50).fill(0) }))',
    );

    expect(observation.logs[0]).not.toContain('more characters');
  });

  it('keeps an observation short when a program logs a lot', async () => {
    const repl = session();
    const observation = await repl.exec(
      'for (let i = 0; i < 5000; i += 1) { console.log("line " + i); }',
    );

    const total = observation.logs.reduce((sum, line) => sum + line.length, 0);
    expect(total).toBeLessThan(17000);
    expect(observation.logs.at(-1)).toContain('more lines were cut');
  });
});
