import type { Conversation } from '../domain/conversation.js';
import { NOT_JAVASCRIPT_ERROR, prepareModelOutput } from '../domain/model-output.js';
import { formatObservation } from '../domain/observation.js';
import type { LlmPort, LlmRequest, LlmStopReason } from '../domain/ports/llm.js';
import type { ReplObservation, ReplPort } from '../domain/ports/repl.js';
import type { UiPort } from '../domain/ports/ui.js';
import { explainReplError } from '../domain/repl-errors.js';

export interface AgentDeps {
  readonly llm: LlmPort;
  readonly repl: ReplPort;
  readonly ui: UiPort;
  readonly systemPrompt: string;
  readonly maxTokens: number;
  readonly maxSteps: number;
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
  conversation.append('user', userText);
  deps.ui.emit({ type: 'user-message', text: userText });
  deps.ui.emit({ type: 'busy', busy: true });
  // The counter exists before the first step does: the budget is worth
  // seeing from the moment the turn starts, not after it.
  deps.ui.emit({ type: 'turn-progress', steps: 0, maxSteps: deps.maxSteps });

  let steps = 0;
  let rejections = 0;

  while (steps < deps.maxSteps) {
    const reply = await collectCode(deps, conversation, signal);
    if (reply === undefined) {
      deps.ui.emit({ type: 'busy', busy: false });
      return { steps, finished: false };
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
      // The step still ends with a code event, so the transcript shows what
      // the model actually produced and the block is closed. Without it the
      // next step would write its code into this step's block.
      deps.ui.emit({ type: 'agent-code', text: prepared.code });
      deps.ui.emit({ type: 'repl-error', text: prepared.problem });
      conversation.append('assistant', prepared.code);
      conversation.append(
        'user',
        formatObservation({
          ok: false,
          logs: [],
          value: undefined,
          error: prepared.problem,
          finalAnswer: undefined,
          step: undefined,
        }),
      );
      if (rejections >= MAX_TRANSPORT_REJECTIONS) {
        deps.ui.emit({
          type: 'status',
          text: `Stopped: the model kept emitting tool calls (${rejections} times).`,
        });
        break;
      }
      continue;
    }

    steps += 1;
    // The step is being worked on now, so n/24 reads "step n of 24" for as
    // long as the step runs.
    deps.ui.emit({ type: 'turn-progress', steps, maxSteps: deps.maxSteps });

    if (prepared.unwrappedToolCall) {
      deps.ui.emit({
        type: 'status',
        text: 'Unwrapped a tool-call envelope from the model output.',
      });
    }

    conversation.append('assistant', prepared.code);
    deps.ui.emit({ type: 'agent-code', text: prepared.code });

    const observation = await deps.repl.exec(prepared.code);
    const reported = withTeachingNote(prepared.invalidSyntax, observation);
    emitObservation(deps.ui, reported);
    conversation.append('user', formatObservation(reported));

    if (observation.finalAnswer !== undefined) {
      deps.ui.emit({ type: 'final', text: observation.finalAnswer });
      deps.ui.emit({ type: 'busy', busy: false });
      return { steps, finished: true };
    }
  }

  deps.ui.emit({ type: 'status', text: `Stopped: reached the limit of ${deps.maxSteps} steps.` });
  deps.ui.emit({ type: 'busy', busy: false });
  return { steps: deps.maxSteps, finished: false };
}

/** What one reply carried: the reasoning that led to it, and the program. */
interface AgentReply {
  readonly code: string;
  readonly thinking: string;
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
  let stopReason: LlmStopReason = 'other';

  try {
    for await (const event of deps.llm.stream(request, signal)) {
      if (event.type === 'text') {
        code += event.text;
        deps.ui.emit({ type: 'agent-code-delta', text: event.text });
        continue;
      }
      if (event.type === 'thinking') {
        thinking += event.text;
        deps.ui.emit({ type: 'agent-thinking-delta' });
        continue;
      }
      stopReason = event.stopReason;
      if (event.usage !== undefined) {
        deps.ui.emit({ type: 'turn-usage', usage: event.usage });
      }
    }
  } catch (error) {
    if (signal.aborted) {
      deps.ui.emit({ type: 'status', text: 'Cancelled.' });
      return undefined;
    }
    throw error;
  }

  if (stopReason === 'max_tokens') {
    deps.ui.emit({ type: 'status', text: 'The reply was cut off (max_tokens reached).' });
  }

  return { code, thinking };
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
  if (observation.step !== undefined) {
    ui.emit({
      type: 'step',
      name: observation.step.name,
      description: observation.step.description,
    });
  }
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
