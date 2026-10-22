import type { Conversation } from '../domain/conversation.js';
import { formatObservation } from '../domain/observation.js';
import type { LlmPort, LlmRequest, LlmStopReason } from '../domain/ports/llm.js';
import type { ReplObservation, ReplPort } from '../domain/ports/repl.js';
import type { UiPort } from '../domain/ports/ui.js';

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

  for (let step = 1; step <= deps.maxSteps; step += 1) {
    const code = await collectCode(deps, conversation, signal);
    if (code === undefined) {
      deps.ui.emit({ type: 'busy', busy: false });
      return { steps: step - 1, finished: false };
    }

    conversation.append('assistant', code);
    deps.ui.emit({ type: 'agent-code', text: code });

    const observation = await deps.repl.exec(code);
    emitObservation(deps.ui, observation);
    conversation.append('user', formatObservation(observation));

    if (observation.finalAnswer !== undefined) {
      deps.ui.emit({ type: 'final', text: observation.finalAnswer });
      deps.ui.emit({ type: 'busy', busy: false });
      return { steps: step, finished: true };
    }
  }

  deps.ui.emit({ type: 'status', text: `Stopped: reached the limit of ${deps.maxSteps} steps.` });
  deps.ui.emit({ type: 'busy', busy: false });
  return { steps: deps.maxSteps, finished: false };
}

/**
 * Ask the model for its next program. Returns `undefined` when the turn was
 * cancelled.
 */
async function collectCode(
  deps: AgentDeps,
  conversation: Conversation,
  signal: AbortSignal,
): Promise<string | undefined> {
  const request: LlmRequest = {
    system: deps.systemPrompt,
    messages: conversation.messages,
    maxTokens: deps.maxTokens,
  };

  let code = '';
  let stopReason: LlmStopReason = 'other';

  try {
    for await (const event of deps.llm.stream(request, signal)) {
      if (event.type === 'text') {
        code += event.text;
        deps.ui.emit({ type: 'agent-code-delta', text: event.text });
        continue;
      }
      stopReason = event.stopReason;
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

  return code;
}

function emitObservation(ui: UiPort, observation: ReplObservation): void {
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
