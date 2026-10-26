import { afterEach, describe, expect, it } from 'vitest';
import { NodeReplSession } from '../src/adapters/repl/node-repl.js';
import type { ReplEvent } from '../src/domain/ports/repl.js';

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

/** Run a unit and collect what it reported. */
async function run(code: string): Promise<{
  outcome: Awaited<ReturnType<NodeReplSession['exec']>>;
  events: ReplEvent[];
}> {
  const events: ReplEvent[] = [];
  const outcome = await session().exec(code, (event) => events.push(event));
  return { outcome, events };
}

describe('NodeReplSession', () => {
  it('runs a unit and reports the step it named', async () => {
    const { outcome, events } = await run(
      'await step("count the files", "read the dir and count what is in it", async () => {})',
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.step).toEqual({
      name: 'count the files',
      description: 'read the dir and count what is in it',
    });
    expect(events).toEqual([
      {
        kind: 'step',
        name: 'count the files',
        description: 'read the dir and count what is in it',
      },
    ]);
  });

  it('names the step before the body runs', async () => {
    const order: string[] = [];
    const repl = session();
    await repl.exec(
      'await step("named", "described", async () => { globalThis.__order = "body"; })',
      (event) => {
        if (event.kind === 'step') {
          order.push('step');
        }
      },
    );
    order.push('done');
    expect(order).toEqual(['step', 'done']);
  });

  it('says what it has to say', async () => {
    const { outcome, events } = await run(
      'await step("say it", "tell the human", async () => { say("it is done"); })',
    );

    expect(outcome.said).toBe(true);
    expect(events.filter((event) => event.kind === 'say')).toEqual([
      { kind: 'say', text: 'it is done' },
    ]);
  });

  it('deposits what the model wants to read next', async () => {
    const { outcome, events } = await run(
      'await step("think", "work something out", async () => { deposit("the answer is 42"); })',
    );

    expect(outcome.said).toBe(false);
    expect(events.filter((event) => event.kind === 'deposit')).toEqual([
      { kind: 'deposit', text: 'the answer is 42' },
    ]);
  });

  it('refuses a step with no name, before the body runs', async () => {
    const { outcome } = await run(
      'await step("", "described", async () => { globalThis.__ran = true; })',
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('needs a name');
  });

  it('refuses a step with no description', async () => {
    const { outcome } = await run('await step("named", "", async () => {})');

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('needs a description');
  });

  it('refuses a step with no program', async () => {
    const { outcome } = await run('await step("named", "described", "not a function")');

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('needs a program');
  });

  it('has no console for the model to write on', async () => {
    const { outcome } = await run('console.log("hello")');

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('console is not defined');
  });

  it('keeps a declaration outside the body from leaking', async () => {
    const repl = session();
    await repl.exec('const leaked = 1; await step("n", "d", async () => {})');
    const outcome = await repl.exec('await step("n", "d", async () => { typeof leaked; })');

    expect(outcome.ok).toBe(true);
  });

  it('keeps what was put on globalThis', async () => {
    const repl = session();
    await repl.exec('await step("stash", "keep it", async () => { globalThis.stashed = "kept"; })');
    const outcome = await repl.exec(
      'await step("fetch", "get it back", async () => { if (globalThis.stashed !== "kept") { throw new Error("lost"); } })',
    );

    expect(outcome.ok).toBe(true);
  });

  it('reports the error a body throws', async () => {
    const { outcome } = await run(
      'await step("boom", "break on purpose", async () => { throw new Error("it broke"); })',
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('it broke');
  });

  it('waits for a body it was not told to await', async () => {
    const { outcome, events } = await run(
      'step("slow", "takes a moment", async () => { await new Promise((r) => setTimeout(r, 20)); deposit("done"); })',
    );

    expect(outcome.ok).toBe(true);
    expect(events.filter((event) => event.kind === 'deposit')).toEqual([
      { kind: 'deposit', text: 'done' },
    ]);
  });

  it('has the toolkit on the context', async () => {
    const { outcome, events } = await run(
      'await step("look", "see what is there", async () => { const names = await ls(".", "see the layout"); deposit(names.join(",")); })',
    );

    expect(outcome.ok).toBe(true);
    const deposit = events.find((event) => event.kind === 'deposit');
    expect(deposit).toBeDefined();
    expect(events.filter((event) => event.kind === 'tool')).toHaveLength(1);
  });

  it('refuses a tool call with no reason for it', async () => {
    const { outcome } = await run(
      'await step("read", "read a file", async () => { await read("package.json", ""); })',
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('needs to know why');
  });

  it('says a syntax error for what it cannot parse', async () => {
    const { outcome } = await run('await step("n", "d", async () => {');

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('SyntaxError');
  });
});
