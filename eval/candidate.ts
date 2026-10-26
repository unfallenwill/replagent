import { NodeReplSession } from '../src/adapters/repl/node-repl.js';
import { runAgentTurn } from '../src/app/agent.js';
import { Conversation } from '../src/domain/conversation.js';
import type { ReplPort } from '../src/domain/ports/repl.js';
import type { UiPort } from '../src/domain/ports/ui.js';
import { MessageQueue } from '../src/domain/queue.js';
import type { EvalSubject, SubjectContext } from './types.js';

/** The production loop and REPL, with a headless UI. No simulated tools. */
export function createSubject(context: SubjectContext): EvalSubject {
  const repl = new NodeReplSession({ cwd: context.cwd });
  const conversation = new Conversation();
  const queue = new MessageQueue();
  return createHeadlessSubject(context, { repl, conversation, queue });
}

export interface HeadlessRuntime {
  readonly repl: ReplPort & { close(): void };
  readonly conversation: Conversation;
  readonly queue: MessageQueue;
}

/** Candidates may provide a harness without forking the production agent loop. */
export function createHeadlessSubject(
  context: SubjectContext,
  { repl, conversation, queue }: HeadlessRuntime,
): EvalSubject {
  const ui: UiPort = {
    emit: context.emit,
    onInput: () => {},
    run: () => Promise.resolve(),
    stop: () => {},
  };

  return {
    async send(text, signal) {
      queue.push('human', text);
      // Match the CLI: deposits left after say can start another turn.
      while (!queue.empty && !signal.aborted) {
        const result = await runAgentTurn(
          {
            llm: context.llm,
            repl,
            ui,
            queue,
            systemPrompt: context.systemPrompt,
            maxTokens: context.budget.maxTokens,
            maxSteps: context.budget.maxSteps,
          },
          conversation,
          signal,
        );
        if (['cancelled', 'limit', 'rejected'].includes(result.status)) {
          throw new Error(`Agent stopped with status: ${result.status}`);
        }
      }
    },
    close: () => repl.close(),
  };
}
