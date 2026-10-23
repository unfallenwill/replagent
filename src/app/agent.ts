import type { Conversation } from '../domain/conversation.js';
import {
  NOT_JAVASCRIPT_ERROR,
  type PreparedCode,
  prepareModelOutput,
} from '../domain/model-output.js';
import { formatObservation } from '../domain/observation.js';
import type {
  LlmMessage,
  LlmPort,
  LlmRequest,
  LlmStopReason,
  LlmThinkingBlock,
  LlmUsage,
} from '../domain/ports/llm.js';
import type { ReplObservation, ReplPort } from '../domain/ports/repl.js';
import type {
  SessionMessageOrigin,
  SessionTurnStatus,
  SessionWriter,
} from '../domain/ports/session.js';
import type { UiPort } from '../domain/ports/ui.js';
import { explainReplError } from '../domain/repl-errors.js';

export interface AgentDeps {
  readonly llm: LlmPort;
  readonly repl: ReplPort;
  readonly ui: UiPort;
  readonly systemPrompt: string;
  readonly maxTokens: number;
  readonly maxSteps: number;
  /** Where the turn is recorded, when the session is being kept. */
  readonly session?: SessionWriter;
}

export interface AgentTurnResult {
  readonly steps: number;
  readonly finished: boolean;
}

/**
 * How many times a turn may be rejected for carrying a tool call before the
 * turn is given up on. The rejection is a transport artefact, but a model
 * that keeps emitting them is not going to stop on its own.
 */
const MAX_TRANSPORT_REJECTIONS = 3;

/**
 * One turn of the agent.
 *
 * The loop is deliberately minimal, because the protocol is minimal: the
 * model writes JavaScript, the REPL runs it, the observation goes back. There
 * is no tool loop, no plan, no scratchpad - the REPL context itself is the
 * agent's scratchpad.
 */
export async function runAgentTurn(
  deps: AgentDeps,
  conversation: Conversation,
  userText: string,
  signal: AbortSignal,
): Promise<AgentTurnResult> {
  const session = deps.session;
  session?.append({ type: 'turn.start' });
  // The work is alive from here to the finally, including the paths where the
  // turn throws: a spinner that never settles is a screen that lies about
  // what is still running.
  deps.ui.emit({ type: 'busy', busy: true });
  let status: SessionTurnStatus = 'error';
  try {
    const result = await runTurn(deps, conversation, userText, signal);
    status = result.status;
    return { steps: result.steps, finished: result.finished };
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
interface TurnOutcome extends AgentTurnResult {
  readonly status: SessionTurnStatus;
}

async function runTurn(
  deps: AgentDeps,
  conversation: Conversation,
  userText: string,
  signal: AbortSignal,
): Promise<TurnOutcome> {
  beginTurn(deps, conversation, userText);

  let steps = 0;
  let rejections = 0;

  while (steps < deps.maxSteps) {
    const reply = await collectCode(deps, conversation, signal);
    if (reply === undefined) {
      return { steps, finished: false, status: 'cancelled' };
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
      rejections += 1;
      rejectTransport(deps, conversation, reply, prepared.code, prepared.problem);
      if (rejections >= MAX_TRANSPORT_REJECTIONS) {
        note(deps, `Stopped: the model kept emitting tool calls (${rejections} times).`);
        break;
      }
      continue;
    }

    steps += 1;
    const observation = await runStep(deps, conversation, reply, prepared, steps);

    if (observation.finalAnswer !== undefined) {
      deps.ui.emit({ type: 'final', text: observation.finalAnswer });
      return { steps, finished: true, status: 'finished' };
    }
  }

  note(deps, `Stopped: reached the limit of ${deps.maxSteps} steps.`);
  return {
    steps,
    finished: false,
    status: rejections >= MAX_TRANSPORT_REJECTIONS ? 'rejected' : 'limit',
  };
}

/** Open the turn: the human's message, and the budget the bar shows. */
function beginTurn(deps: AgentDeps, conversation: Conversation, userText: string): void {
  remember(deps, conversation, { role: 'user', text: userText }, 'human');
  deps.ui.emit({ type: 'user-message', text: userText });
  // The counter exists before the first step does: the budget is worth
  // seeing from the moment the turn starts, not after it.
  deps.ui.emit({ type: 'turn-progress', steps: 0, maxSteps: deps.maxSteps });
}

/**
 * A reply that could not be turned into code.
 *
 * The step still ends with a code event, so the transcript shows what the
 * model actually produced and the block is closed. Without it the next step
 * would write its code into this step's block.
 */
function rejectTransport(
  deps: AgentDeps,
  conversation: Conversation,
  reply: AgentReply,
  code: string,
  problem: string,
): void {
  deps.ui.emit({ type: 'agent-code', text: code });
  deps.ui.emit({ type: 'repl-error', text: problem });
  recordAssistant(deps, conversation, reply, code);
  recordObservation(deps, conversation, {
    ok: false,
    logs: [],
    value: undefined,
    error: problem,
    finalAnswer: undefined,
    step: undefined,
  });
}

/** Run one program and report what it did. */
async function runStep(
  deps: AgentDeps,
  conversation: Conversation,
  reply: AgentReply,
  prepared: PreparedCode,
  steps: number,
): Promise<ReplObservation> {
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
  // is being done instead of waiting for the observation to come back.
  const observation = await deps.repl.exec(prepared.code, (step) => {
    deps.ui.emit({ type: 'step', name: step.name, description: step.description });
  });
  deps.ui.emit({ type: 'exec-done' });
  const reported = withTeachingNote(prepared.invalidSyntax, observation);
  emitObservation(deps.ui, reported);
  recordObservation(deps, conversation, reported);
  return observation;
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

/** The observation goes to the log in structure, and to the model as text. */
function recordObservation(
  deps: AgentDeps,
  conversation: Conversation,
  observation: ReplObservation,
): void {
  deps.session?.append({ type: 'observation', observation });
  remember(
    deps,
    conversation,
    { role: 'user', text: formatObservation(observation) },
    'observation',
  );
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
 * Ask the model for its next program. Returns `undefined` when the turn was
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

/**
 * When the reply was not JavaScript at all, the REPL's parse error is precise
 * but does not tell the model what it did wrong. Add that.
 */
function withTeachingNote(invalidSyntax: boolean, observation: ReplObservation): ReplObservation {
  if (observation.error === undefined) {
    return observation;
  }
  if (invalidSyntax) {
    return { ...observation, error: `${observation.error}\n${NOT_JAVASCRIPT_ERROR}` };
  }
  const note = explainReplError(observation.error);
  if (note === undefined) {
    return observation;
  }
  return { ...observation, error: `${observation.error}\n${note.note}` };
}

function emitObservation(ui: UiPort, observation: ReplObservation): void {
  // The step was already reported when it named itself, before it ran.
  for (const log of observation.logs) {
    ui.emit({ type: 'repl-log', text: log });
  }
  if (observation.value !== undefined) {
    ui.emit({ type: 'repl-value', text: observation.value });
  }
  if (observation.error !== undefined) {
    ui.emit({ type: 'repl-error', text: observation.error });
  }
}
