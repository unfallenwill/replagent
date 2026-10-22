import { describe, expect, it } from 'vitest';
import { type AgentDeps, runAgentTurn } from '../src/app/agent.js';
import { Conversation } from '../src/domain/conversation.js';
import type { LlmPort, LlmRequest, LlmStreamEvent } from '../src/domain/ports/llm.js';
import type { ReplObservation, ReplPort } from '../src/domain/ports/repl.js';
import type { UiEvent, UiPort } from '../src/domain/ports/ui.js';

class ScriptedLlm implements LlmPort {
  readonly requests: LlmRequest[] = [];
  readonly #replies: readonly string[];

  constructor(replies: readonly string[]) {
    this.#replies = replies;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    this.requests.push(request);
    const reply = this.#replies[this.requests.length - 1] ?? '';
    yield { type: 'text', text: reply };
    yield { type: 'done', stopReason: 'end_turn' };
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

  async exec(code: string): Promise<ReplObservation> {
    this.executed.push(code);
    const next = this.#observations[this.executed.length - 1];
    return next ?? noopObservation;
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
  mismatch: undefined,
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

  it('shows the agent that its prediction was wrong', async () => {
    const llm = new ScriptedLlm(['const a = 1;']);
    const repl = new ScriptedRepl([
      { ...noopObservation, value: '1', mismatch: 'MISMATCH: expected 2, got 1' },
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
      type: 'repl-mismatch',
      text: 'MISMATCH: expected 2, got 1',
    });
    expect(conversation.messages[2]?.text).toContain('MISMATCH: expected 2, got 1');
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
