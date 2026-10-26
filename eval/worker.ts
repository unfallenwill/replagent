import { pathToFileURL } from 'node:url';
import type { LlmPort, LlmRequest, LlmStreamEvent } from '../src/domain/ports/llm.js';
import type { FromWorker, ToWorker } from './protocol.js';
import type { EvalSubject, SubjectFactory } from './types.js';

interface Pending {
  readonly resolve: (events: readonly LlmStreamEvent[]) => void;
  readonly reject: (error: Error) => void;
}

/** Credentials and graders stay in the controller, outside this process. */
class RemoteLlm implements LlmPort {
  readonly pending = new Map<number, Pending>();
  #nextId = 0;

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    signal.throwIfAborted();
    const id = ++this.#nextId;
    const events = await new Promise<readonly LlmStreamEvent[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      send({ type: 'llm.request', id, request });
    });
    signal.throwIfAborted();
    for (const event of events) {
      yield event;
    }
  }

  accept(message: Extract<ToWorker, { type: 'llm.result' | 'llm.error' }>): void {
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.type === 'llm.error') {
      pending?.reject(new Error(message.error));
    } else {
      pending?.resolve(message.events);
    }
  }
}

function send(message: FromWorker): void {
  process.send?.(message);
}

async function execute(message: Extract<ToWorker, { type: 'start' }>, llm: LlmPort): Promise<void> {
  const module = (await import(pathToFileURL(message.candidate).href)) as {
    createSubject?: SubjectFactory;
  };
  if (typeof module.createSubject !== 'function') {
    throw new Error('Candidate must export createSubject(context).');
  }
  let turn = 0;
  const subject: EvalSubject = await module.createSubject({
    cwd: process.cwd(),
    llm,
    systemPrompt: message.systemPrompt,
    budget: message.budget,
    emit: (event) => send({ type: 'ui', turn, event }),
  });
  try {
    for (const text of message.turns) {
      send({ type: 'turn.start', turn });
      await subject.send(text, new AbortController().signal);
      await new Promise<void>((resolve) => {
        continueTurn = resolve;
        send({ type: 'turn.end', turn });
      });
      turn += 1;
    }
  } finally {
    await subject.close();
  }
}

const llm = new RemoteLlm();
let started = false;
let continueTurn: (() => void) | undefined;
process.on('message', (message: ToWorker) => {
  if (message.type === 'turn.continue') {
    continueTurn?.();
    continueTurn = undefined;
    return;
  }
  if (message.type !== 'start') {
    llm.accept(message);
    return;
  }
  if (started) {
    return;
  }
  started = true;
  void execute(message, llm).then(
    () => send({ type: 'finished' }),
    (error: unknown) =>
      send({ type: 'error', error: error instanceof Error ? error.message : String(error) }),
  );
});
