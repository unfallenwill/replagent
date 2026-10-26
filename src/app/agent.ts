import type { Conversation } from '../domain/conversation.js';
import {
  NOT_JAVASCRIPT_ERROR,
  type PreparedCode,
  prepareModelOutput,
} from '../domain/model-output.js';
import type {
  LlmMessage,
  LlmPort,
  LlmRequest,
  LlmStopReason,
  LlmThinkingBlock,
  LlmUsage,
} from '../domain/ports/llm.js';
import type { ReplEvent, ReplOutcome, ReplPort } from '../domain/ports/repl.js';
import type {
  SessionMessageOrigin,
  SessionTurnStatus,
  SessionWriter,
} from '../domain/ports/session.js';
import type { UiPort } from '../domain/ports/ui.js';
import { formatQueue, type MessageQueue, type QueueEntry } from '../domain/queue.js';
import { NOT_A_UNIT } from '../domain/unit.js';

export interface AgentDeps {
  readonly llm: LlmPort;
  readonly repl: ReplPort;
  readonly ui: UiPort;
  /**
   * The one channel the model reads from.
   *
   * The human's words, the model's own deposits and the errors of a failed
   * unit all arrive the same way: as entries in this queue, drained into
   * the next request.
   */
  readonly queue: MessageQueue;
  readonly systemPrompt: string;
  readonly maxTokens: number;
  readonly maxSteps: number;
  /** Where the turn is recorded, when the session is being kept. */
  readonly session?: SessionWriter;
}

export interface AgentTurnResult {
  readonly steps: number;
  readonly finished: boolean;
  /** How the turn ended, for the log and for whoever comes next. */
  readonly status: SessionTurnStatus;
}

/**
 * How many times a turn may be rejected for carrying a tool call before the
 * turn is given up on. The rejection is a transport artefact, but a model
 * that keeps emitting them is not going to stop on its own.
 */
const MAX_TRANSPORT_REJECTIONS = 3;

/**
 * What the model is told when its reply ran but never named a step.
 *
 * The scanner judges the shape of a reply before it runs, so this only
 * happens when the shape was wrong in a way the scanner cannot see - a step
 * behind a condition that was false, for instance.
 */
const NO_STEP: string =
  'Your reply ran, but it never named a step. A reply is one call to step, and it has ' +
  'to be the thing the reply does: await step("what this is called", "what it does", ' +
  'async (name, description) => { ... });';

/**
 * One turn of the agent.
 *
 * The loop is deliberately minimal, because the protocol is minimal: the
 * model writes one unit, the REPL runs it, and everything the model has to
 * read comes back through one queue. There is no tool loop, no plan, no
 * scratchpad - the REPL context itself is the agent's scratchpad.
 */
export async function runAgentTurn(
  deps: AgentDeps,
  conversation: Conversation,
  signal: AbortSignal,
): Promise<AgentTurnResult> {
  const session = deps.session;
  session?.append({ type: 'turn.start' });
  // The work is alive from here to the finally, including the paths where the
  // turn throws: a spinner that never settles is a screen that lies about
  // what is still running.
  deps.ui.emit({ type: 'busy', busy: true });
  // The counter exists before the first step does: the budget is worth
  // seeing from the moment the turn starts, not after it.
  deps.ui.emit({ type: 'turn-progress', steps: 0, maxSteps: deps.maxSteps });
  let status: SessionTurnStatus = 'error';
  try {
    const result = await runTurn(deps, conversation, signal);
    status = result.status;
    return { steps: result.steps, finished: result.finished, status: result.status };
  } finally {
    deps.ui.emit({ type: 'busy', busy: false });
    // The turn becomes durable at its boundary, not per token: a crash can
    // cost the turn that was running, but the log never holds a turn that
    // says it ended when it did not.
    session?.append({ type: 'turn.end', status });
    session?.checkpoint();
  }
}

/** One turn's result, with the way it ended for the log. */
interface TurnOutcome {
  readonly steps: number;
  readonly finished: boolean;
  readonly status: SessionTurnStatus;
}

async function runTurn(
  deps: AgentDeps,
  conversation: Conversation,
  signal: AbortSignal,
): Promise<TurnOutcome> {
  let steps = 0;
  let rejections = 0;

  while (steps < deps.maxSteps) {
    if (deps.queue.empty) {
      // There is nothing to send, so there is nothing to ask about: the
      // round is over until the human says something.
      return { steps, finished: false, status: 'idle' };
    }

    const round = await runRound(deps, conversation, signal, steps, rejections);
    steps = round.steps;
    rejections = round.rejections;
    if (round.outcome !== undefined) {
      return round.outcome;
    }
  }

  note(deps, `Stopped: reached the limit of ${deps.maxSteps} steps.`);
  return { steps, finished: false, status: 'limit' };
}

/** What one round of the loop did to the turn's counters. */
interface RoundResult {
  /** How many steps the turn has taken. */
  readonly steps: number;
  /** How many transport rejections the turn has seen. */
  readonly rejections: number;
  /** How the round ended the turn, when it ended it. */
  readonly outcome: TurnOutcome | undefined;
}

/**
 * One round: the queue goes out, a reply comes back, and it is judged.
 *
 * A round that does not end the turn says so by having no outcome, and the
 * loop asks for another one.
 */
async function runRound(
  deps: AgentDeps,
  conversation: Conversation,
  signal: AbortSignal,
  steps: number,
  rejections: number,
): Promise<RoundResult> {
  sendQueue(deps, conversation, deps.queue.drain());

  const reply = await collectCode(deps, conversation, signal);
  if (reply === undefined) {
    return { steps, rejections, outcome: { steps, finished: false, status: 'cancelled' } };
  }

  // The reasoning came first, so the transcript gets it first - on the
  // rejected path too: it happened, even if what it produced is wrong.
  if (reply.thinking.length > 0) {
    deps.ui.emit({ type: 'agent-thinking', text: reply.thinking });
  }

  const prepared = prepareModelOutput(reply.code);

  // A tool call is a transport artefact, not a reasoning failure: it does
  // not cost the agent a step of its budget, it only costs a round trip.
  if (prepared.problem !== undefined) {
    return rejectTransport(deps, conversation, reply, prepared, rejections, steps);
  }

  const taken = steps + 1;

  // A reply that is not a unit is a wrong answer, and it costs a step:
  // the model is told what a unit is, and tries again.
  if (prepared.invalidSyntax || !prepared.unit.ok) {
    rejectReply(deps, conversation, reply, prepared.code, unitProblem(prepared));
    return { steps: taken, rejections, outcome: undefined };
  }

  const outcome = await runUnit(deps, conversation, reply, prepared, taken);
  if (outcome.said) {
    // The agent spoke: the round is over, and the human has the last word.
    return {
      steps: taken,
      rejections,
      outcome: { steps: taken, finished: true, status: 'finished' },
    };
  }
  return { steps: taken, rejections, outcome: undefined };
}

/**
 * A reply that carried a tool call rather than a program.
 *
 * The rejection does not cost the agent a step of its budget, it only costs
 * a round trip. A model that keeps emitting them is not going to stop on
 * its own, so there is a limit.
 */
function rejectTransport(
  deps: AgentDeps,
  conversation: Conversation,
  reply: AgentReply,
  prepared: PreparedCode,
  rejections: number,
  steps: number,
): RoundResult {
  const count = rejections + 1;
  rejectReply(deps, conversation, reply, prepared.code, prepared.problem ?? NOT_JAVASCRIPT_ERROR);

  if (count < MAX_TRANSPORT_REJECTIONS) {
    return { steps, rejections: count, outcome: undefined };
  }
  note(deps, `Stopped: the model kept emitting tool calls (${count} times).`);
  return { steps, rejections: count, outcome: { steps, finished: false, status: 'rejected' } };
}

/**
 * The message the model gets when its reply was not a unit.
 *
 * Code that does not parse is a different failure from code that parses
 * into the wrong shape, and each needs its own lesson.
 */
function unitProblem(prepared: PreparedCode): string {
  if (prepared.invalidSyntax) {
    return NOT_JAVASCRIPT_ERROR;
  }
  return prepared.unit.problem ?? NOT_A_UNIT;
}

/**
 * What went into the request.
 *
 * The queue is the whole of it: the human's words, the model's deposits and
 * the errors, in the order they arrived. The log keeps the entries, not the
 * text that was rendered from them, so a resume can rebuild the request
 * exactly.
 */
function sendQueue(
  deps: AgentDeps,
  conversation: Conversation,
  entries: readonly QueueEntry[],
): void {
  for (const entry of entries) {
    if (entry.origin === 'human') {
      deps.ui.emit({ type: 'user-message', text: entry.text });
    }
  }
  deps.session?.append({ type: 'queue', entries });
  conversation.append('user', formatQueue(entries));
}

/**
 * A reply that could not be run.
 *
 * The step still ends with a code event, so the transcript shows what the
 * model actually produced and the block is closed. Without it the next step
 * would write its code into this step's block.
 */
function rejectReply(
  deps: AgentDeps,
  conversation: Conversation,
  reply: AgentReply,
  code: string,
  problem: string,
): void {
  deps.ui.emit({ type: 'agent-code', text: code });
  deps.ui.emit({ type: 'repl-error', text: problem });
  recordAssistant(deps, conversation, reply, code);
  // The problem goes into the queue, so the model reads it on the next
  // request instead of having to be told twice.
  deps.queue.push('error', problem);
}

/** Run one unit and report what it did. */
async function runUnit(
  deps: AgentDeps,
  conversation: Conversation,
  reply: AgentReply,
  prepared: PreparedCode,
  steps: number,
): Promise<ReplOutcome> {
  // The step is being worked on now, so n/24 reads "step n of 24" for as
  // long as the step runs.
  deps.ui.emit({ type: 'turn-progress', steps, maxSteps: deps.maxSteps });

  if (prepared.unwrappedToolCall) {
    deps.ui.emit({
      type: 'status',
      text: 'Unwrapped a tool-call envelope from the model output.',
    });
  }

  recordAssistant(deps, conversation, reply, prepared.code);
  deps.ui.emit({ type: 'agent-code', text: prepared.code });

  // The step names itself while it runs, so the transcript can say what
  // is being done instead of waiting for the unit to come back.
  const outcome = await deps.repl.exec(prepared.code, (event) => {
    reportEvent(deps, event);
  });

  if (outcome.error !== undefined) {
    // A failure is always seen by the model: the error goes into the queue,
    // where the next request carries it.
    deps.ui.emit({ type: 'repl-error', text: outcome.error });
    deps.queue.push('error', outcome.error);
  } else if (outcome.step === undefined) {
    deps.ui.emit({ type: 'repl-error', text: NO_STEP });
    deps.queue.push('error', NO_STEP);
  }
  deps.ui.emit({ type: 'exec-done' });

  return outcome;
}

/**
 * What happened inside the unit.
 *
 * Three of the four events are for the human; the fourth is the model's own
 * channel back to itself, and it goes into the queue.
 */
function reportEvent(deps: AgentDeps, event: ReplEvent): void {
  switch (event.kind) {
    case 'step':
      deps.ui.emit({ type: 'step', name: event.name, description: event.description });
      deps.session?.append({ type: 'step', name: event.name, description: event.description });
      return;
    case 'tool':
      deps.ui.emit({
        type: 'tool',
        tool: event.tool,
        intent: event.intent,
        detail: event.detail,
      });
      deps.session?.append({
        type: 'tool',
        tool: event.tool,
        intent: event.intent,
        detail: event.detail,
      });
      return;
    case 'say':
      deps.ui.emit({ type: 'say', text: event.text });
      deps.session?.append({ type: 'say', text: event.text });
      return;
    case 'deposit':
      deps.queue.push('model', event.text);
      return;
  }
}

/** The assistant turn goes into the conversation and into the log together. */
function recordAssistant(
  deps: AgentDeps,
  conversation: Conversation,
  reply: AgentReply,
  code: string,
): void {
  remember(deps, conversation, assistantMessage(code, reply), 'assistant', {
    ...(reply.usage !== undefined ? { usage: reply.usage } : {}),
    stopReason: reply.stopReason,
  });
}

/** A turn as it enters the log: what the conversation was given, and why. */
function remember(
  deps: AgentDeps,
  conversation: Conversation,
  message: LlmMessage,
  origin: SessionMessageOrigin,
  meta: { readonly usage?: LlmUsage; readonly stopReason?: LlmStopReason } = {},
): void {
  if (message.text.length === 0) {
    // The conversation drops empty text, so the log must not keep a message
    // the model never saw.
    return;
  }
  conversation.append(message.role, message.text, message.thinking);
  deps.session?.append({
    type: 'message',
    message,
    origin,
    ...(meta.usage !== undefined ? { usage: meta.usage } : {}),
    ...(meta.stopReason !== undefined ? { stopReason: meta.stopReason } : {}),
  });
}

function assistantMessage(text: string, reply: AgentReply): LlmMessage {
  return {
    role: 'assistant',
    text,
    ...(reply.thinkingBlocks.length > 0 ? { thinking: reply.thinkingBlocks } : {}),
  };
}

/** A note is both something to show and something the session keeps. */
function note(deps: AgentDeps, text: string): void {
  deps.ui.emit({ type: 'status', text });
  deps.session?.append({ type: 'note', text });
}

/** What one reply carried: the reasoning that led to it, and the program. */
interface AgentReply {
  readonly code: string;
  /** The reasoning as text, for the transcript. */
  readonly thinking: string;
  /** The reasoning as blocks, to travel back to the model with the turn. */
  readonly thinkingBlocks: readonly LlmThinkingBlock[];
  /** What the call cost, when the endpoint said. */
  readonly usage: LlmUsage | undefined;
  readonly stopReason: LlmStopReason;
}

/**
 * Ask the model for its next unit. Returns `undefined` when the turn was
 * cancelled.
 */
async function collectCode(
  deps: AgentDeps,
  conversation: Conversation,
  signal: AbortSignal,
): Promise<AgentReply | undefined> {
  const request: LlmRequest = {
    system: deps.systemPrompt,
    messages: conversation.messages,
    maxTokens: deps.maxTokens,
  };

  let code = '';
  let thinking = '';
  let thinkingBlocks: readonly LlmThinkingBlock[] = [];
  let stopReason: LlmStopReason = 'other';
  let usage: LlmUsage | undefined;

  try {
    for await (const event of deps.llm.stream(request, signal)) {
      if (event.type === 'text') {
        code += event.text;
        deps.ui.emit({ type: 'agent-code-delta', text: event.text });
        continue;
      }
      if (event.type === 'thinking') {
        thinking += event.text;
        deps.ui.emit({ type: 'agent-thinking-delta', chars: thinking.length });
        continue;
      }
      stopReason = event.stopReason;
      if (event.thinking !== undefined) {
        thinkingBlocks = event.thinking;
      }
      if (event.usage !== undefined) {
        usage = event.usage;
        deps.ui.emit({ type: 'turn-usage', usage: event.usage });
      }
    }
  } catch (error) {
    if (signal.aborted) {
      note(deps, 'Cancelled.');
      return undefined;
    }
    throw error;
  }

  if (stopReason === 'max_tokens') {
    note(deps, 'The reply was cut off (max_tokens reached).');
  }

  return { code, thinking, thinkingBlocks, usage, stopReason };
}
