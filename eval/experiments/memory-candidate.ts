import { randomUUID } from 'node:crypto';
import { NodeReplSession } from '../../src/adapters/repl/node-repl.js';
import { Conversation } from '../../src/domain/conversation.js';
import { MessageQueue } from '../../src/domain/queue.js';
import { createHeadlessSubject, type HeadlessRuntime } from '../candidate.js';
import type { EvalSubject, SubjectContext } from '../types.js';
import { MEMORY_HELP, MemoryController } from './memory.js';

/** Bind through the process module shared by Node's REPL context and this worker. */
function memoryRepl(context: SubjectContext, memory: MemoryController): HeadlessRuntime['repl'] {
  const repl = new NodeReplSession({ cwd: context.cwd });
  const key = `replagent-experiment-${randomUUID()}`;
  const registry = process as unknown as Record<symbol, unknown>;
  registry[Symbol.for(key)] = (token: number) => memory.bind(token);
  return {
    async exec(code, onEvent) {
      const token = memory.begin();
      try {
        const prefix = `globalThis.harness=require('node:process')[Symbol.for(${JSON.stringify(key)})](${token});\n`;
        const outcome = await repl.exec(prefix + code, onEvent);
        memory.finish(outcome.ok && outcome.step !== undefined);
        return outcome;
      } catch (error) {
        memory.finish(false);
        throw error;
      }
    },
    close() {
      delete registry[Symbol.for(key)];
      repl.close();
    },
  };
}

export function createSubject(context: SubjectContext): EvalSubject {
  const conversation = new Conversation();
  const queue = new MessageQueue();
  const memory = new MemoryController(conversation, context.emit);
  const subject = createHeadlessSubject(context, {
    conversation,
    queue,
    repl: memoryRepl(context, memory),
  });
  queue.push('model', MEMORY_HELP);
  return {
    send(text, signal) {
      memory.remember(text);
      return subject.send(text, signal);
    },
    close: () => subject.close(),
  };
}
