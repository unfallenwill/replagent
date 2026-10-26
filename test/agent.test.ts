import { describe, expect, it } from 'vitest';
import { type AgentDeps, type AgentTurnResult, runAgentTurn } from '../src/app/agent.js';
import { Conversation } from '../src/domain/conversation.js';
import type { LlmPort, LlmRequest, LlmStreamEvent } from '../src/domain/ports/llm.js';
import type { ReplEvent, ReplOutcome, ReplPort } from '../src/domain/ports/repl.js';
import type { SessionEventInput, SessionWriter } from '../src/domain/ports/session.js';
import type { UiEvent, UiPort } from '../src/domain/ports/ui.js';
import { MessageQueue } from '../src/domain/queue.js';

class ScriptedLlm implements LlmPort {
  readonly requests: LlmRequest[] = [];
  readonly #replies: readonly string[];
  readonly #thinking: readonly string[];

  constructor(replies: readonly string[], thinking: readonly string[] = []) {
    this.#replies = replies;
    this.#thinking = thinking;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    // The request is a snapshot: the conversation keeps growing while the
    // turn runs, and what the model was given is what it was given.
    this.requests.push({ ...request, messages: [...request.messages] });
    const index = this.requests.length - 1;
    const thinking = this.#thinking[index] ?? '';
    if (thinking.length > 0) {
      yield { type: 'thinking', text: thinking };
    }
    yield { type: 'text', text: this.#replies[index] ?? '' };
    yield {
      type: 'done',
      stopReason: 'end_turn',
      ...(thinking.length > 0 ? { thinking: [{ text: thinking, signature: `sig-${index}` }] } : {}),
    };
  }
}

class MeteredLlm implements LlmPort {
  async *stream(): AsyncIterable<LlmStreamEvent> {
    yield { type: 'text', text: 'await step("n", "d", async () => {});' };
    yield { type: 'done', stopReason: 'end_turn', usage: { input: 120, output: 9, cached: 100 } };
  }
}

class FailingLlm implements LlmPort {
  stream(): AsyncIterable<LlmStreamEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
      }),
    };
  }
}

/** What one unit did, as the REPL would report it. */
interface ScriptedRun {
  readonly events: readonly ReplEvent[];
  readonly outcome: ReplOutcome;
}

class ScriptedRepl implements ReplPort {
  readonly executed: string[] = [];
  readonly #runs: readonly ScriptedRun[];

  constructor(runs: readonly ScriptedRun[] = []) {
    this.#runs = runs;
  }

  async exec(code: string, onEvent?: (event: ReplEvent) => void): Promise<ReplOutcome> {
    this.executed.push(code);
    const next = this.#runs[this.executed.length - 1] ?? quietRun;
    for (const event of next.events) {
      onEvent?.(event);
    }
    return next.outcome;
  }
}

/** A unit that did nothing in particular. */
const quietRun: ScriptedRun = {
  events: [],
  outcome: { ok: true, error: undefined, step: undefined, said: false },
};

/**
 * A unit that did these things and came back clean.
 *
 * Every unit names itself before its body runs, so the fake names it too -
 * unless the test wants to say which name.
 */
function did(...events: readonly ReplEvent[]): ScriptedRun {
  const step = events.find(
    (event): event is Extract<ReplEvent, { kind: 'step' }> => event.kind === 'step',
  );
  const named = step ?? NAMED;
  const all = step === undefined ? [NAMED, ...events] : events;
  return {
    events: all,
    outcome: {
      ok: true,
      error: undefined,
      step: { name: named.name, description: named.description },
      said: all.some((event) => event.kind === 'say'),
    },
  };
}

/** The name a unit gives itself when the test does not care. */
const NAMED: Extract<ReplEvent, { kind: 'step' }> = {
  kind: 'step',
  name: 'a step',
  description: 'what it does',
};

/** A unit that threw. */
function failed(error: string): ScriptedRun {
  return { events: [], outcome: { ok: false, error, step: undefined, said: false } };
}

class RecordingSession implements SessionWriter {
  readonly id = 'test-session';
  readonly events: SessionEventInput[] = [];

  append(event: SessionEventInput): void {
    this.events.push(event);
  }

  checkpoint(): void {
    // not used in these tests
  }

  close(): void {
    // not used in these tests
  }
}

class RecordingUi implements UiPort {
  readonly events: UiEvent[] = [];

  emit(event: UiEvent): void {
    this.events.push(event);
  }

  onInput(): void {
    // not used in these tests
  }

  async run(): Promise<void> {
    // not used in these tests
  }

  stop(): void {
    // not used in these tests
  }
}

function deps(
  llm: LlmPort,
  repl: ReplPort,
  ui: UiPort,
  maxSteps = 4,
  queue: MessageQueue = new MessageQueue(),
): AgentDeps {
  return {
    llm,
    repl,
    ui,
    queue,
    systemPrompt: 'you speak javascript',
    maxTokens: 1024,
    maxSteps,
  };
}

/** A queue with the human's words in it, the way the CLI leaves it. */
function waiting(text: string): MessageQueue {
  const queue = new MessageQueue();
  queue.push('human', text);
  return queue;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** The text of the last message the model was sent. */
function lastRequest(llm: ScriptedLlm): string {
  return llm.requests.at(-1)?.messages.at(-1)?.text ?? '';
}

describe('runAgentTurn', () => {
  it('runs the unit and hands the deposit back to the model', async () => {
    const llm = new ScriptedLlm([
      'await step("count", "count what is in src", async () => { deposit("42"); });',
      'await step("answer", "tell the human", async () => { say("there are 42"); });',
    ]);
    const repl = new ScriptedRepl([
      did({ kind: 'deposit', text: '42' }),
      did(
        { kind: 'step', name: 'answer', description: 'tell the human' },
        { kind: 'say', text: 'there are 42' },
      ),
    ]);
    const ui = new RecordingUi();
    const conversation = new Conversation();

    const result = await runAgentTurn(
      deps(llm, repl, ui, 4, waiting('how many modules?')),
      conversation,
      signal(),
    );

    expect(repl.executed).toHaveLength(2);
    expect(result.finished).toBe(true);
    // The deposit went into the queue, and the next request carried it -
    // labelled, so the model can tell its own conclusion from the human.
    expect(lastRequest(llm)).toBe('<queue>\n[you] 42\n</queue>');
  });

  it('gives the human the words he typed, labelled as his', async () => {
    const llm = new ScriptedLlm(['await step("n", "d", async () => { say("hi"); });']);
    const repl = new ScriptedRepl([did({ kind: 'say', text: 'hi' })]);

    await runAgentTurn(
      deps(llm, repl, new RecordingUi(), 1, waiting('say hi')),
      new Conversation(),
      signal(),
    );

    expect(llm.requests[0]?.messages.at(-1)?.text).toBe('<queue>\n[human] say hi\n</queue>');
  });

  it('ends the round when the agent says something', async () => {
    const llm = new ScriptedLlm(['await step("n", "d", async () => { say("the answer"); });']);
    const repl = new ScriptedRepl([did({ kind: 'say', text: 'the answer' })]);
    const ui = new RecordingUi();

    const result = await runAgentTurn(
      deps(llm, repl, ui, 4, waiting('say something')),
      new Conversation(),
      signal(),
    );

    expect(result.finished).toBe(true);
    expect(result.steps).toBe(1);
    expect(ui.events).toContainEqual({ type: 'say', text: 'the answer' });
  });

  it('shows the agent the step it ran', async () => {
    const llm = new ScriptedLlm(['await step("n", "d", async () => { say("done"); });']);
    const repl = new ScriptedRepl([
      did(
        { kind: 'step', name: 'add one', description: 'count up' },
        { kind: 'say', text: 'done' },
      ),
    ]);
    const ui = new RecordingUi();

    await runAgentTurn(
      deps(llm, repl, ui, 1, waiting('what is one?')),
      new Conversation(),
      signal(),
    );

    expect(ui.events).toContainEqual({
      type: 'step',
      name: 'add one',
      description: 'count up',
    });
    // The name arrives while the code runs, so the transcript can say what
    // is being done; the receipt that it finished comes after.
    const kinds = ui.events.map((event) => event.type);
    expect(kinds.indexOf('step')).toBeLessThan(kinds.indexOf('exec-done'));
  });

  it('shows the tool the agent used, and why', async () => {
    const llm = new ScriptedLlm(['await step("n", "d", async () => { say("done"); });']);
    const repl = new ScriptedRepl([
      did(
        { kind: 'tool', tool: 'read', intent: 'see the layout', detail: 'src/app/agent.ts' },
        { kind: 'say', text: 'done' },
      ),
    ]);
    const ui = new RecordingUi();

    await runAgentTurn(deps(llm, repl, ui, 1, waiting('look')), new Conversation(), signal());

    expect(ui.events).toContainEqual({
      type: 'tool',
      tool: 'read',
      intent: 'see the layout',
      detail: 'src/app/agent.ts',
    });
  });

  it('gives up after the step limit', async () => {
    const llm = new ScriptedLlm([
      'await step("a", "a", async () => { deposit("a"); });',
      'await step("b", "b", async () => { deposit("b"); });',
      'await step("c", "c", async () => { deposit("c"); });',
      'await step("d", "d", async () => { deposit("d"); });',
      'await step("e", "e", async () => { deposit("e"); });',
    ]);
    const repl = new ScriptedRepl([
      did({ kind: 'deposit', text: 'a' }),
      did({ kind: 'deposit', text: 'b' }),
      did({ kind: 'deposit', text: 'c' }),
      did({ kind: 'deposit', text: 'd' }),
    ]);
    const ui = new RecordingUi();

    const result = await runAgentTurn(
      deps(llm, repl, ui, 4, waiting('loop')),
      new Conversation(),
      signal(),
    );

    expect(result.finished).toBe(false);
    expect(result.steps).toBe(4);
    expect(result.status).toBe('limit');
    expect(ui.events).toContainEqual({
      type: 'status',
      text: 'Stopped: reached the limit of 4 steps.',
    });
  });

  it('hands a unit that threw back to the model', async () => {
    const llm = new ScriptedLlm([
      'await step("boom", "break on purpose", async () => { throw new Error("it broke"); });',
      'await step("again", "try again", async () => { say("never mind"); });',
    ]);
    const repl = new ScriptedRepl([
      failed('Error: it broke'),
      did({ kind: 'say', text: 'never mind' }),
    ]);
    const ui = new RecordingUi();

    await runAgentTurn(deps(llm, repl, ui, 4, waiting('break it')), new Conversation(), signal());

    // The failure is always seen by the model: it is in the queue, labelled
    // as an error rather than as something the human said.
    expect(lastRequest(llm)).toContain('[error] Error: it broke');
    expect(ui.events).toContainEqual({ type: 'repl-error', text: 'Error: it broke' });
  });

  it('teaches the model when its reply is not a unit, and charges it for it', async () => {
    const llm = new ScriptedLlm([
      'const a = 1;',
      'await step("n", "d", async () => { say("now it is a unit"); });',
    ]);
    const repl = new ScriptedRepl([did({ kind: 'say', text: 'now it is a unit' })]);
    const conversation = new Conversation();

    const result = await runAgentTurn(
      deps(llm, repl, new RecordingUi(), 4, waiting('do it')),
      conversation,
      signal(),
    );

    expect(lastRequest(llm)).toContain('[error] Your reply was not a unit');
    // A reply in the wrong shape is a wrong answer, and it costs a step.
    expect(result.steps).toBe(2);
  });

  it('teaches the model when its reply is not javascript', async () => {
    const llm = new ScriptedLlm([
      'Sure! Here is how you do it:',
      'await step("n", "d", async () => { say("now it is code"); });',
    ]);
    const repl = new ScriptedRepl([did({ kind: 'say', text: 'now it is code' })]);

    await runAgentTurn(
      deps(llm, repl, new RecordingUi(), 2, waiting('do it')),
      new Conversation(),
      signal(),
    );

    expect(lastRequest(llm)).toContain('was not valid JavaScript');
  });

  it('emits a code event for a rejected turn as well', async () => {
    const llm = new ScriptedLlm([
      '<tool_call>{"name": "fetch"}</tool_call>',
      'await step("n", "d", async () => { say("ok"); });',
    ]);
    const repl = new ScriptedRepl([did({ kind: 'say', text: 'ok' })]);
    const ui = new RecordingUi();

    await runAgentTurn(
      deps(llm, repl, ui, 4, waiting('do something')),
      new Conversation(),
      signal(),
    );

    const codeTexts = ui.events.flatMap((event) =>
      event.type === 'agent-code' ? [event.text] : [],
    );

    // The rejected step still reports what it produced, so the block is
    // closed and the next step writes below it.
    expect(codeTexts.length).toBeGreaterThanOrEqual(2);
    expect(codeTexts[0]).toContain('tool_call');
    expect(ui.events.some((event) => event.type === 'repl-error')).toBe(true);
  });

  it('gives up on a model that keeps emitting tool calls', async () => {
    const llm = new ScriptedLlm([
      '<tool_call>{"name": "fetch"}</tool_call>',
      '<tool_call>{"name": "fetch"}</tool_call>',
      '<tool_call>{"name": "fetch"}</tool_call>',
    ]);
    const repl = new ScriptedRepl([]);

    const result = await runAgentTurn(
      deps(llm, repl, new RecordingUi(), 4, waiting('fetch it')),
      new Conversation(),
      signal(),
    );

    // A tool call is a transport artefact: it costs a round trip, not a
    // step of the budget.
    expect(result.steps).toBe(0);
    expect(result.status).toBe('rejected');
  });

  it('unwraps a tool call and runs the payload', async () => {
    const llm = new ScriptedLlm([
      '<tool_call>{"name": "repl", "input": {"code": "await step(\\"n\\", \\"d\\", async () => {});"}}</tool_call>',
    ]);
    const repl = new ScriptedRepl([]);
    const ui = new RecordingUi();

    await runAgentTurn(deps(llm, repl, ui, 2, waiting('compute')), new Conversation(), signal());

    expect(repl.executed).toEqual(['await step("n", "d", async () => {});']);
    expect(ui.events).toContainEqual({
      type: 'status',
      text: 'Unwrapped a tool-call envelope from the model output.',
    });
  });

  it('reports the turn budget as it is spent', async () => {
    const llm = new ScriptedLlm([
      'await step("a", "a", async () => { deposit("a"); });',
      'await step("b", "b", async () => { deposit("b"); });',
    ]);
    const repl = new ScriptedRepl([
      did({ kind: 'deposit', text: 'a' }),
      did({ kind: 'deposit', text: 'b' }),
    ]);
    const ui = new RecordingUi();

    await runAgentTurn(deps(llm, repl, ui, 2, waiting('loop')), new Conversation(), signal());

    // The counter exists before the first step does, and rises with each
    // one: that is what the bar has to show.
    expect(ui.events.filter((event) => event.type === 'turn-progress')).toEqual([
      { type: 'turn-progress', steps: 0, maxSteps: 2 },
      { type: 'turn-progress', steps: 1, maxSteps: 2 },
      { type: 'turn-progress', steps: 2, maxSteps: 2 },
    ]);
    // No reply carried usage, so none is reported.
    expect(ui.events.some((event) => event.type === 'turn-usage')).toBe(false);
  });

  it('relays what the model call cost', async () => {
    const llm = new MeteredLlm();
    const repl = new ScriptedRepl([]);
    const ui = new RecordingUi();

    await runAgentTurn(deps(llm, repl, ui, 2, waiting('compute')), new Conversation(), signal());

    expect(ui.events).toContainEqual({
      type: 'turn-usage',
      usage: { input: 120, output: 9, cached: 100 },
    });
  });

  it('reports the reasoning before the code, in the order it happened', async () => {
    const llm = new ScriptedLlm(
      ['await step("n", "d", async () => { say("done"); });'],
      ['the answer is in the file'],
    );
    const repl = new ScriptedRepl([did({ kind: 'say', text: 'done' })]);
    const ui = new RecordingUi();

    await runAgentTurn(deps(llm, repl, ui, 1, waiting('do it')), new Conversation(), signal());

    const kinds = ui.events.map((event) => event.type);
    const thinking = kinds.indexOf('agent-thinking');
    const code = kinds.indexOf('agent-code');

    expect(ui.events).toContainEqual({ type: 'agent-thinking', text: 'the answer is in the file' });
    // The delta carries how much has arrived, so the fold can count as the
    // reasoning grows.
    expect(ui.events).toContainEqual({ type: 'agent-thinking-delta', chars: 25 });
    expect(thinking).toBeGreaterThan(-1);
    expect(code).toBeGreaterThan(thinking);
  });

  it('keeps the reasoning with the assistant turn for the next request', async () => {
    const llm = new ScriptedLlm(
      ['await step("n", "d", async () => { deposit("x"); });'],
      ['one is the first number'],
    );
    const repl = new ScriptedRepl([did({ kind: 'deposit', text: 'x' })]);
    const conversation = new Conversation();

    await runAgentTurn(
      deps(llm, repl, new RecordingUi(), 1, waiting('what is one?')),
      conversation,
      signal(),
    );

    expect(conversation.messages[1]).toEqual({
      role: 'assistant',
      text: 'await step("n", "d", async () => { deposit("x"); });',
      thinking: [{ text: 'one is the first number', signature: 'sig-0' }],
    });
  });

  it('reports the reasoning of a reply that was rejected too', async () => {
    const llm = new ScriptedLlm(
      ['<tool_call>{"name": "fetch"}</tool_call>'],
      ['I could just fetch this'],
    );
    const ui = new RecordingUi();

    await runAgentTurn(
      deps(llm, new ScriptedRepl([]), ui, 1, waiting('do it')),
      new Conversation(),
      signal(),
    );

    // The thought happened, even though what it produced is not runnable.
    expect(ui.events).toContainEqual({
      type: 'agent-thinking',
      text: 'I could just fetch this',
    });
  });

  it('reports no reasoning when the model did not think', async () => {
    const llm = new ScriptedLlm(['await step("n", "d", async () => { say("done"); });']);
    const ui = new RecordingUi();

    await runAgentTurn(
      deps(llm, new ScriptedRepl([did({ kind: 'say', text: 'done' })]), ui, 1, waiting('do it')),
      new Conversation(),
      signal(),
    );

    expect(ui.events.some((event) => event.type === 'agent-thinking')).toBe(false);
    expect(ui.events.some((event) => event.type === 'agent-thinking-delta')).toBe(false);
  });

  it('reports the end of the execution even when there is nothing to report', async () => {
    const llm = new ScriptedLlm(['await step("n", "d", async () => { deposit("x"); });']);
    const repl = new ScriptedRepl([did({ kind: 'deposit', text: 'x' })]);
    const ui = new RecordingUi();

    await runAgentTurn(deps(llm, repl, ui, 1, waiting('do it')), new Conversation(), signal());

    // Without this the step's line would spin forever: an empty unit still
    // means the code is done.
    expect(ui.events.filter((event) => event.type === 'exec-done')).toHaveLength(1);
  });

  it('records the turn in the session, in the order it happened', async () => {
    const llm = new ScriptedLlm(['await step("n", "d", async () => { say("done"); });']);
    const repl = new ScriptedRepl([
      did({ kind: 'step', name: 'n', description: 'd' }, { kind: 'say', text: 'done' }),
    ]);
    const session = new RecordingSession();

    await runAgentTurn(
      { ...deps(llm, repl, new RecordingUi(), 1, waiting('what is one?')), session },
      new Conversation(),
      signal(),
    );

    expect(session.events.map((event) => event.type)).toEqual([
      'turn.start',
      'queue',
      'message',
      'step',
      'say',
      'turn.end',
    ]);
    // The queue keeps the entries, not the text that was rendered from them.
    expect(session.events[1]).toEqual({
      type: 'queue',
      entries: [{ origin: 'human', text: 'what is one?' }],
    });
    expect(session.events[2]).toMatchObject({
      type: 'message',
      origin: 'assistant',
      message: { role: 'assistant' },
    });
    expect(session.events[3]).toEqual({ type: 'step', name: 'n', description: 'd' });
    expect(session.events[4]).toEqual({ type: 'say', text: 'done' });
    expect(session.events[5]).toEqual({ type: 'turn.end', status: 'finished' });
  });

  it('marks a finished turn as finished, and a cancelled one as cancelled', async () => {
    const finished = new RecordingSession();
    await runAgentTurn(
      {
        ...deps(
          new ScriptedLlm(['await step("n", "d", async () => { say("done"); });']),
          new ScriptedRepl([did({ kind: 'say', text: 'done' })]),
          new RecordingUi(),
          1,
          waiting('do it'),
        ),
        session: finished,
      },
      new Conversation(),
      signal(),
    );
    expect(finished.events.at(-1)).toEqual({ type: 'turn.end', status: 'finished' });

    const cancelled = new RecordingSession();
    const controller = new AbortController();
    controller.abort();
    await runAgentTurn(
      {
        ...deps(new FailingLlm(), new ScriptedRepl([]), new RecordingUi(), 1, waiting('do it')),
        session: cancelled,
      },
      new Conversation(),
      controller.signal,
    );
    expect(cancelled.events.at(-1)).toEqual({ type: 'turn.end', status: 'cancelled' });
  });

  it('stops when the turn is cancelled', async () => {
    const llm = new FailingLlm();
    const repl = new ScriptedRepl([]);
    const ui = new RecordingUi();
    const controller = new AbortController();
    controller.abort();

    const result: AgentTurnResult = await runAgentTurn(
      deps(llm, repl, ui, 1, waiting('do it')),
      new Conversation(),
      controller.signal,
    );

    expect(result.finished).toBe(false);
    expect(result.status).toBe('cancelled');
    expect(ui.events).toContainEqual({ type: 'status', text: 'Cancelled.' });
    expect(ui.events).toContainEqual({ type: 'busy', busy: false });
  });

  it('settles the work when the turn throws', async () => {
    const ui = new RecordingUi();

    await expect(
      runAgentTurn(
        deps(new FailingLlm(), new ScriptedRepl([]), ui, 1, waiting('do it')),
        new Conversation(),
        signal(),
      ),
    ).rejects.toThrow();

    // The error is reported by whoever catches it; the spinner is this
    // function's to stop, and a spinner that never settles says work is
    // still running when nothing is.
    expect(ui.events).toContainEqual({ type: 'busy', busy: false });
  });
});
