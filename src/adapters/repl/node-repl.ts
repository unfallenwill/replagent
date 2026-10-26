import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import repl from 'node:repl';
import { PassThrough } from 'node:stream';
import { type Context, runInContext } from 'node:vm';
import type { ReplEvent, ReplOutcome, ReplPort, ReplStep } from '../../domain/ports/repl.js';
import { createToolkit } from '../toolkit/index.js';

/**
 * Node 24 changed the public shape of `REPLServer.prototype.eval` to
 * `eval(code, filename, callback)` and broke it in the process: the wrapper
 * passes the context object where Node's C++ layer expects a filename string,
 * and the process aborts with an assertion failure.
 *
 * The four argument form `eval(code, context, filename, callback)` is what
 * Node itself uses internally, and it was the public signature before Node 24.
 * We call that one directly and keep the cast in exactly one place.
 */
type NodeEvalCallback = (error: Error | null, result?: unknown) => void;

type NodeEval = (
  code: string,
  context: Context,
  filename: string,
  callback: NodeEvalCallback,
) => void;

/** `repl.Recoverable` is not part of the public typings, but it is exported. */
type RecoverableConstructor = new (...args: never[]) => SyntaxError;

const Recoverable = (repl as unknown as { Recoverable: RecoverableConstructor }).Recoverable;

type EvalOutcome =
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'incomplete'; readonly message: string };

/** The body of a step: it gets its own name and description. */
type StepBody = (name: string, description: string) => unknown;

/** How much one deposit may carry into the next request. */
const MAX_DEPOSIT_CHARS = 40_000;

/** How much one thing said to the human may be. */
const MAX_SAY_CHARS = 8000;

export interface NodeReplOptions {
  /** Directory `require` resolves from, and where the tools work. Defaults to the process cwd. */
  readonly cwd?: string;
  /** File name used in stack traces. */
  readonly filename?: string;
}

/**
 * Wait for a promise the program handed back.
 *
 * Anything that is not thenable is the answer already. A promise that
 * rejects is a failed run, not a failed program.
 */
async function settleValue(value: unknown): Promise<EvalOutcome> {
  if (!isThenable(value)) {
    return { kind: 'ok', value };
  }

  try {
    return { kind: 'ok', value: await value };
  } catch (error) {
    return { kind: 'error', message: errorText(error) };
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  return typeof (value as PromiseLike<unknown>).then === 'function';
}

/**
 * The message of an error, as the model should read it.
 *
 * The stack is kept: where it broke is half of what the model needs to know.
 */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

/**
 * The message of an error the REPL printed to its output.
 *
 * The format depends on the realm the error came from: an error raised
 * inside the REPL's own context prints as "Uncaught Error: boom", one
 * raised outside it prints as "Uncaught:" followed by the stack.
 */
function uncaughtMessage(text: string): string {
  return text.replace(/^Uncaught:?\s*/, '').trim();
}

/**
 * Cut a line down to what the agent can afford to read.
 *
 * The note says how much was left out, so the agent knows it is looking
 * at a part of the truth and can go and ask for the rest.
 */
function cut(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}… ${text.length - limit} more characters`;
}

/**
 * The unit, wrapped so that it is one scope.
 *
 * A reply is one call to `step`, but the model can put anything around it.
 * Wrapping the whole reply in one async function means a declaration made
 * outside the step's body dies with the reply: the only things that survive
 * from one unit to the next are the ones put on `globalThis` on purpose.
 *
 * The code starts on the first line, so a stack trace still points at the
 * line the model wrote.
 */
function wrapUnit(code: string): string {
  return `(async () => {${code}\n})()`;
}

/**
 * What a helper was given to say.
 *
 * A helper with nothing to say has nothing to do either: an empty deposit
 * is a mistake, and a mistake the model cannot see is a mistake it repeats.
 */
function spoken(text: unknown, helper: 'say' | 'deposit'): string {
  const value = typeof text === 'string' ? text : String(text);
  if (value.trim().length === 0) {
    throw new Error(
      helper === 'say'
        ? 'say needs something to say: say("what the human should read").'
        : 'deposit needs something to deposit: deposit("what you want to read next turn").',
    );
  }
  return value;
}

/** The error of a run, from whichever of the two paths failed. */
function errorOf(outcome: EvalOutcome, settled: EvalOutcome): string | undefined {
  if (outcome.kind !== 'ok') {
    return outcome.message;
  }
  if (settled.kind !== 'ok') {
    return settled.message;
  }
  return undefined;
}

/**
 * A persistent Node REPL, used as the agent's world.
 *
 * One `repl.REPLServer` with its own context: `let`/`const`, required modules
 * and top level await survive between calls, exactly like the interactive
 * REPL, because we drive Node's own evaluator.
 *
 * The context holds the three helpers the protocol has - `step`, `deposit`
 * and `say` - and the toolkit. It does not hold a console: the REPL's own
 * console writes to the process stdout, which is the alternate screen the
 * transcript lives on, and a model that logs would scribble over it.
 */
export class NodeReplSession implements ReplPort {
  readonly #server: repl.REPLServer;
  readonly #context: Context;
  readonly #eval: NodeEval;
  readonly #filename: string;
  #execToken = 0;
  #onEvent: ((event: ReplEvent) => void) | undefined;
  #onUncaught: ((text: string) => void) | undefined;
  #step: ReplStep | undefined;
  #stepPromise: Promise<unknown> | undefined;
  #said = false;

  constructor(options: NodeReplOptions) {
    const input = new PassThrough();
    const output = new PassThrough();

    this.#server = repl.start({
      prompt: '',
      terminal: false,
      useGlobal: false,
      ignoreUndefined: true,
      preview: false,
      input,
      output,
    });
    this.#context = this.#server.context;
    this.#eval = this.#server.eval.bind(this.#server) as unknown as NodeEval;
    this.#filename = options.filename ?? 'replagent';

    const cwd = options.cwd ?? process.cwd();
    this.#removeConsole();
    this.#installRequire(cwd);
    this.#installToolkit(cwd);
    this.#installStep();
    this.#tapUncaught(output);
  }

  async exec(code: string, onEvent?: (event: ReplEvent) => void): Promise<ReplOutcome> {
    this.#execToken += 1;
    const token = this.#execToken;
    this.#onEvent = onEvent;
    this.#step = undefined;
    this.#stepPromise = undefined;
    this.#said = false;
    this.#installTalkers(token);

    const outcome = await this.#evaluate(wrapUnit(code));
    // The unit may not have awaited its own step. The REPL waits for the
    // work either way, so a body that is still running cannot outlive the
    // turn and leave its deposits behind.
    const settled = await settleValue(this.#stepPromise);
    this.#onEvent = undefined;

    return {
      ok: outcome.kind === 'ok' && settled.kind === 'ok',
      error: errorOf(outcome, settled),
      step: this.#step,
      said: this.#said,
    };
  }

  /** Release the REPL's resources (readline interface, timers). */
  close(): void {
    this.#server.close();
  }

  /**
   * Run the code, then wait for what it hands back.
   *
   * A unit is a self-executing closure, and an async one hands back a
   * promise. The REPL waits for it, so the agent's answer arrives as a
   * value and not as a pending promise, and a rejected promise becomes an
   * error the agent can read.
   */
  async #evaluate(code: string): Promise<EvalOutcome> {
    const outcome = await this.#evaluateOnce(code);
    if (outcome.kind !== 'ok') {
      return outcome;
    }
    return settleValue(outcome.value);
  }

  #evaluateOnce(code: string): Promise<EvalOutcome> {
    return new Promise<EvalOutcome>((resolve) => {
      let settled = false;

      const settle = (outcome: EvalOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.#onUncaught = undefined;
        resolve(outcome);
      };

      // A runtime error is swallowed by the REPL's domain and never reaches
      // the callback - it is printed to the output stream instead. We tap that
      // stream so the agent still gets an observation instead of hanging.
      this.#onUncaught = (text: string): void => {
        settle({ kind: 'error', message: text.trim() });
      };

      try {
        this.#eval(code, this.#context, this.#filename, (error, result) => {
          if (error instanceof Recoverable) {
            settle({
              kind: 'incomplete',
              message: `SyntaxError: ${error.message || 'incomplete input'}`,
            });
            return;
          }
          if (error !== null) {
            settle({ kind: 'error', message: error.stack ?? error.message });
            return;
          }
          settle({ kind: 'ok', value: result });
        });
      } catch (error) {
        settle({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  #emit(event: ReplEvent): void {
    this.#onEvent?.(event);
  }

  /**
   * Take the console away.
   *
   * The REPL gives the model a console of its own, pointed at the process
   * stdout - which is the alternate screen the transcript is drawn on. A
   * model that logs would scribble over the screen, so the console is
   * removed rather than captured: a model that writes to it gets a clean
   * ReferenceError and learns to use `say` instead.
   */
  #removeConsole(): void {
    runInContext('delete globalThis.console', this.#context);
  }

  /**
   * `deposit` and `say` are rebound for every turn.
   *
   * The binding captures the turn it belongs to, so a `say()` that arrives
   * late (from a timer started in an earlier turn) cannot end the current
   * one.
   */
  #installTalkers(token: number): void {
    this.#context['say'] = (text: unknown): void => {
      if (token !== this.#execToken) {
        return;
      }
      const said = spoken(text, 'say');
      this.#said = true;
      this.#emit({ kind: 'say', text: cut(said, MAX_SAY_CHARS) });
    };

    this.#context['deposit'] = (text: unknown): void => {
      if (token !== this.#execToken) {
        return;
      }
      const note = spoken(text, 'deposit');
      this.#emit({ kind: 'deposit', text: cut(note, MAX_DEPOSIT_CHARS) });
    };
  }

  /**
   * One step: a name, a description of what it is for, and the program.
   *
   * The name and the description are required, because a step that does not
   * say what it is is a step nobody can read - not the agent, not the human
   * reading the transcript a hundred steps later. The REPL keeps them
   * before the body runs, so the intent is recorded before the action, and
   * the body gets both, so it can label itself.
   */
  #installStep(): void {
    this.#context['step'] = (
      name: unknown,
      description: unknown,
      body: unknown,
    ): Promise<unknown> => {
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw new Error(
          'A step needs a name: step("what this step is called", "what it does", async (name, description) => { ... })',
        );
      }
      if (typeof description !== 'string' || description.trim().length === 0) {
        throw new Error(
          'A step needs a description of what it does: step("what this step is called", "what it does", async (name, description) => { ... })',
        );
      }
      if (typeof body !== 'function') {
        throw new Error(
          'A step needs a program to run: step("what this step is called", "what it does", async (name, description) => { ... })',
        );
      }

      const step: ReplStep = { name, description };
      this.#step = step;
      // The observer hears the name before the body runs: that is the whole
      // point of naming the step first.
      this.#emit({ kind: 'step', name, description });

      const promise = (async () => (body as StepBody)(name, description))();
      this.#stepPromise = promise;
      // The failure is reported through the outcome, so the promise must
      // never be left unhandled: a unit that forgot to await its step would
      // otherwise take the whole process down with it.
      promise.catch(() => undefined);
      return promise;
    };
  }

  /**
   * The tools.
   *
   * They are the same functions the toolkit is, mounted on the context: a
   * helper that reports what it did becomes a line in the transcript, and
   * the reason it was called is part of that line.
   */
  #installToolkit(cwd: string): void {
    const toolkit = createToolkit({
      cwd,
      onAction: (action) => {
        this.#emit({
          kind: 'tool',
          tool: action.tool,
          intent: action.intent,
          detail: action.detail,
        });
      },
    });

    this.#context['read'] = toolkit.read;
    this.#context['ls'] = toolkit.ls;
    this.#context['glob'] = toolkit.glob;
    this.#context['edit'] = toolkit.edit;
    this.#context['bash'] = toolkit.bash;
  }

  #installRequire(cwd: string): void {
    this.#context['require'] = createRequire(path.join(cwd, 'index.js'));
  }

  #tapUncaught(output: PassThrough): void {
    output.on('data', (chunk: unknown) => {
      const text = String(chunk);
      if (text.startsWith('Uncaught')) {
        this.#onUncaught?.(uncaughtMessage(text));
      }
    });
  }
}
