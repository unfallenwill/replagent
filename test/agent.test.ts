import { describe, expect, it } from 'vitest';
import { type AgentDeps, runAgentTurn } from '../src/app/agent.js';
import { Conversation } from '../src/domain/conversation.js';
import type { LlmPort, LlmRequest, LlmStreamEvent } from '../src/domain/ports/llm.js';
import type { ReplObservation, ReplPort, ReplStep } from '../src/domain/ports/repl.js';
import type { UiEvent, UiPort } from '../src/domain/ports/ui.js';

class ScriptedLlm implements LlmPort {
  readonly requests: LlmRequest[] = [];
  readonly #replies: readonly string[];
  readonly #thinking: readonly string[];

  constructor(replies: readonly string[], thinking: readonly string[] = []) {
    this.#replies = replies;
    this.#thinking = thinking;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    this.requests.push(request);
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
    yield { type: 'text', text: '1;' };
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

class ScriptedRepl implements ReplPort {
  readonly executed: string[] = [];
  readonly #observations: readonly ReplObservation[];

  constructor(observations: readonly ReplObservation[]) {
    this.#observations = observations;
  }

  async exec(code: string, onStep?: (step: ReplStep) => void): Promise<ReplObservation> {
    this.executed.push(code);
    const next = this.#observations[this.executed.length - 1] ?? noopObservation;
    // The real REPL reports the step while the body is still running; the
    // fake reports it before returning, which is early enough for the
    // ordering the UI cares about.
    if (next.step !== undefined) {
      onStep?.(next.step);
    }
    return next;
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

function deps(llm: LlmPort, repl: ReplPort, ui: UiPort, maxSteps = 4): AgentDeps {
  return {
    llm,
    repl,
    ui,
    systemPrompt: 'you speak javascript',
    maxTokens: 1024,
    maxSteps,
  };
}

const noopObservation: ReplObservation = {
  ok: true,
  logs: [],
  value: undefined,
  error: undefined,
  finalAnswer: undefined,
  step: undefined,
};

describe('runAgentTurn', () => {
  it('executes the model output and feeds the observation back', async () => {
    const llm = new ScriptedLlm(['const a = 1;', 'console.log(a);']);
    const repl = new ScriptedRepl([
      { ...noopObservation, value: 'undefined' },
      { ...noopObservation, logs: ['1'], value: 'undefined' },
    ]);
    const ui = new RecordingUi();
    const conversation = new Conversation();

    const result = await runAgentTurn(
      deps(llm, repl, ui, 2),
      conversation,
      'what is one?',
      new AbortController().signal,
    );

    expect(repl.executed).toEqual(['const a = 1;', 'console.log(a);']);
    expect(result.finished).toBe(false);
    expect(conversation.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(conversation.messages[2]?.text).toBe('<observation>\n=> undefined\n</observation>');
  });

  it('stops when the agent calls finish()', async () => {
    const llm = new ScriptedLlm(['finish("the answer")']);
    const repl = new ScriptedRepl([
      { ...noopObservation, value: 'the answer', finalAnswer: 'the answer' },
    ]);
    const ui = new RecordingUi();

    const result = await runAgentTurn(
      deps(llm, repl, ui),
      new Conversation(),
      'say something',
      new AbortController().signal,
    );

    expect(result.finished).toBe(true);
    expect(result.steps).toBe(1);
    expect(ui.events).toContainEqual({ type: 'final', text: 'the answer' });
  });

  it('shows the agent the step it ran', async () => {
    const llm = new ScriptedLlm(['const a = 1;']);
    const repl = new ScriptedRepl([
      { ...noopObservation, value: '1', step: { name: 'add one', description: 'count up' } },
    ]);
    const ui = new RecordingUi();
    const conversation = new Conversation();

    await runAgentTurn(
      deps(llm, repl, ui),
      conversation,
      'what is one?',
      new AbortController().signal,
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

  it('gives up after the step limit', async () => {
    const llm = new ScriptedLlm(['1', '2', '3', '4', '5']);
    const repl = new ScriptedRepl([]);
    const ui = new RecordingUi();

    const result = await runAgentTurn(
      deps(llm, repl, ui),
      new Conversation(),
      'loop',
      new AbortController().signal,
    );

    expect(result.finished).toBe(false);
    expect(result.steps).toBe(4);
    expect(ui.events).toContainEqual({
      type: 'status',
      text: 'Stopped: reached the limit of 4 steps.',
    });
  });

  it('reports the observation to the user', async () => {
    const llm = new ScriptedLlm(['console.log("hi")']);
    const repl = new ScriptedRepl([{ ...noopObservation, logs: ['hi'] }]);
    const ui = new RecordingUi();

    await runAgentTurn(
      deps(llm, repl, ui),
      new Conversation(),
      'say hi',
      new AbortController().signal,
    );

    expect(ui.events).toContainEqual({ type: 'repl-log', text: 'hi' });
    expect(ui.events).toContainEqual({ type: 'agent-code', text: 'console.log("hi")' });
  });

  it('emits a code event for a rejected turn as well', async () => {
    const llm = new ScriptedLlm(['<tool_call>{"name": "fetch"}</tool_call>', 'console.log("ok")']);
    const repl = new ScriptedRepl([{ ...noopObservation }]);
    const ui = new RecordingUi();

    await runAgentTurn(
      deps(llm, repl, ui, 4),
      new Conversation(),
      'do something',
      new AbortController().signal,
    );

    const codeTexts = ui.events.flatMap((event) =>
      event.type === 'agent-code' ? [event.text] : [],
    );

    // The rejected step still reports what it produced, so the block is
    // closed and the next step writes below it.
    expect(codeTexts.length).toBeGreaterThanOrEqual(2);
    expect(codeTexts[0]).toContain('tool_call');
    expect(codeTexts[1]).toBe('console.log("ok")');
    expect(ui.events.some((event) => event.type === 'repl-error')).toBe(true);
  });

  it('unwraps a tool call and runs the payload', async () => {
    const llm = new ScriptedLlm([
      '<tool_call>{"name": "repl", "input": {"code": "1 + 1"}}</tool_call>',
    ]);
    const repl = new ScriptedRepl([{ ...noopObservation, value: '2' }]);
    const ui = new RecordingUi();

    await runAgentTurn(
      deps(llm, repl, ui, 2),
      new Conversation(),
      'compute',
      new AbortController().signal,
    );

    expect(repl.executed).toEqual(['1 + 1']);
    expect(ui.events).toContainEqual({
      type: 'status',
      text: 'Unwrapped a tool-call envelope from the model output.',
    });
  });

  it('teaches the model when its reply is not javascript', async () => {
    const llm = new ScriptedLlm(['Sure! Here is how you do it:']);
    const repl = new ScriptedRepl([
      { ...noopObservation, ok: false, error: "SyntaxError: Unexpected identifier 'Sure'" },
    ]);
    const ui = new RecordingUi();
    const conversation = new Conversation();

    await runAgentTurn(deps(llm, repl, ui, 2), conversation, 'do it', new AbortController().signal);

    const observation = conversation.messages[2]?.text ?? '';
    expect(observation).toContain('was not valid JavaScript');
  });

  it('reports the turn budget as it is spent', async () => {
    const llm = new ScriptedLlm(['const a = 1;', 'const b = 2;']);
    const repl = new ScriptedRepl([{ ...noopObservation }, { ...noopObservation }]);
    const ui = new RecordingUi();

    await runAgentTurn(
      deps(llm, repl, ui, 2),
      new Conversation(),
      'loop',
      new AbortController().signal,
    );

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
    const repl = new ScriptedRepl([
      { ...noopObservation, value: 'the answer', finalAnswer: 'the answer' },
    ]);
    const ui = new RecordingUi();

    await runAgentTurn(
      deps(llm, repl, ui),
      new Conversation(),
      'compute',
      new AbortController().signal,
    );

    expect(ui.events).toContainEqual({
      type: 'turn-usage',
      usage: { input: 120, output: 9, cached: 100 },
    });
  });

  it('reports the reasoning before the code, in the order it happened', async () => {
    const llm = new ScriptedLlm(['finish("done")'], ['the answer is in the file']);
    const repl = new ScriptedRepl([{ ...noopObservation, value: 'done', finalAnswer: 'done' }]);
    const ui = new RecordingUi();

    await runAgentTurn(
      deps(llm, repl, ui),
      new Conversation(),
      'do it',
      new AbortController().signal,
    );

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
    const llm = new ScriptedLlm(['const a = 1;'], ['one is the first number']);
    const repl = new ScriptedRepl([{ ...noopObservation, value: 'undefined' }]);
    const conversation = new Conversation();

    await runAgentTurn(
      deps(llm, repl, new RecordingUi(), 1),
      conversation,
      'what is one?',
      new AbortController().signal,
    );

    expect(conversation.messages[1]).toEqual({
      role: 'assistant',
      text: 'const a = 1;',
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
      deps(llm, new ScriptedRepl([]), ui, 1),
      new Conversation(),
      'do it',
      new AbortController().signal,
    );

    // The thought happened, even though what it produced is not runnable.
    expect(ui.events).toContainEqual({
      type: 'agent-thinking',
      text: 'I could just fetch this',
    });
  });

  it('reports no reasoning when the model did not think', async () => {
    const llm = new ScriptedLlm(['finish("done")']);
    const ui = new RecordingUi();

    await runAgentTurn(
      deps(llm, new ScriptedRepl([{ ...noopObservation, finalAnswer: 'done' }]), ui),
      new Conversation(),
      'do it',
      new AbortController().signal,
    );

    expect(ui.events.some((event) => event.type === 'agent-thinking')).toBe(false);
    expect(ui.events.some((event) => event.type === 'agent-thinking-delta')).toBe(false);
  });

  it('reports the end of the execution even when there is nothing to report', async () => {
    const llm = new ScriptedLlm(['1;']);
    const repl = new ScriptedRepl([{ ...noopObservation }]);
    const ui = new RecordingUi();

    await runAgentTurn(
      deps(llm, repl, ui),
      new Conversation(),
      'do it',
      new AbortController().signal,
    );

    // Without this the step's line would spin forever: an empty observation
    // still means the code is done.
    expect(ui.events.filter((event) => event.type === 'exec-done')).toHaveLength(1);
  });

  it('stops when the turn is cancelled', async () => {
    const llm = new FailingLlm();
    const repl = new ScriptedRepl([]);
    const ui = new RecordingUi();
    const controller = new AbortController();
    controller.abort();

    const result = await runAgentTurn(
      deps(llm, repl, ui),
      new Conversation(),
      'do it',
      controller.signal,
    );

    expect(result.finished).toBe(false);
    expect(ui.events).toContainEqual({ type: 'status', text: 'Cancelled.' });
    expect(ui.events).toContainEqual({ type: 'busy', busy: false });
  });
});
