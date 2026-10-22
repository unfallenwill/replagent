import { Console } from 'node:console';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import repl from 'node:repl';
import { PassThrough, Writable } from 'node:stream';
import type { Context } from 'node:vm';
import type { ReplObservation, ReplPort, ReplStep } from '../../domain/ports/repl.js';
import type { WorldPort, WorldState } from '../../domain/ports/world.js';
import { addBelief, addFact, formatWorld, setPlan } from '../../domain/world.js';

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
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return { kind: 'error', message };
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  return typeof (value as PromiseLike<unknown>).then === 'function';
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
 * Cut a run of lines down to what one observation may say.
 */
function trimLogs(logs: readonly string[]): string[] {
  let total = 0;
  const kept: string[] = [];

  for (const log of logs) {
    if (total + log.length > MAX_OBSERVATION_CHARS) {
      kept.push(`… ${logs.length - kept.length} more lines were cut`);
      return kept;
    }
    kept.push(log);
    total += log.length;
  }

  return kept;
}

export interface NodeReplOptions {
  /** Directory `require` resolves from. Defaults to the process cwd. */
  readonly cwd?: string;
  /** File name used in stack traces. */
  readonly filename?: string;
  /** Where the agent's model of the world is kept. */
  readonly world: WorldPort;
}

/** The body of a step: it gets its own name and description. */
type StepBody = (name: string, description: string) => unknown;

/**
 * How much of one line the REPL keeps.
 *
 * An observation is the agent's only sense and also its context: a value
 * dumped in full costs more than the whole conversation, and buries the
 * one line in it that mattered.
 *
 * The limit is generous on purpose. While the agent is exploring it does
 * not know yet what it is looking for, and cutting the answer to "how big
 * is this" off is cutting off the exploration. The limit is there to stop
 * a flood, not to ration the view.
 */
const MAX_LINE_CHARS = 8000;

/**
 * How much one observation may say in total.
 *
 * A program that logs a thousand lines is a program that wants to be
 * summarised, not quoted.
 */
const MAX_OBSERVATION_CHARS = 16000;

/**
 * A persistent Node REPL, used as the agent's world.
 *
 * One `repl.REPLServer` with its own context: `let`/`const`, required modules
 * and top level await survive between calls, exactly like the interactive
 * REPL, because we drive Node's own evaluator.
 */
export class NodeReplSession implements ReplPort {
  readonly #server: repl.REPLServer;
  readonly #context: Context;
  readonly #eval: NodeEval;
  readonly #filename: string;
  readonly #logs: string[] = [];
  readonly #worldPort: WorldPort;
  #worldState: WorldState;
  #finalAnswer: string | undefined;
  #execToken = 0;
  #onUncaught: ((text: string) => void) | undefined;
  #onStep: ((step: ReplStep) => void) | undefined;
  #step: ReplStep | undefined;

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
    this.#worldPort = options.world;
    this.#worldState = options.world.read();

    this.#installConsole();
    this.#installRequire(options.cwd ?? process.cwd());
    this.#installWorld();
    this.#installStep();
    this.#tapUncaught(output);
  }

  async exec(code: string, onStep?: (step: ReplStep) => void): Promise<ReplObservation> {
    this.#execToken += 1;
    const token = this.#execToken;
    this.#logs.length = 0;
    this.#finalAnswer = undefined;
    this.#step = undefined;
    this.#onStep = onStep;
    this.#installFinish(token);

    const outcome = await this.#evaluate(code);
    // A step named by code that outlived its evaluation belongs to nobody.
    this.#onStep = undefined;
    const logs = trimLogs([...this.#logs]);
    const step = this.#step;

    if (outcome.kind !== 'ok') {
      return {
        ok: false,
        logs,
        value: undefined,
        error: cut(outcome.message, MAX_LINE_CHARS),
        finalAnswer: undefined,
        step,
      };
    }

    return {
      ok: true,
      logs,
      value: this.#render(outcome.value),
      error: undefined,
      finalAnswer: this.#finalAnswer,
      step,
    };
  }

  /** Release the REPL's resources (readline interface, timers). */
  close(): void {
    this.#server.close();
  }

  /**
   * Run the code, then wait for what it hands back.
   *
   * A reply is a self-executing closure, and an async one hands back a
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

  #render(value: unknown): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    return cut(this.#server.writer(value) ?? String(value), MAX_LINE_CHARS);
  }

  /**
   * The agent's console.
   *
   * It is Node's own console, pointed at a sink that captures what is
   * written. The agent gets the console it already knows - format
   * specifiers, `console.table`, `console.dir`, `console.count` - and every
   * line it writes becomes an observation.
   */
  #installConsole(): void {
    const sink = new Writable({
      write: (chunk, _encoding, callback) => {
        this.#capture(String(chunk));
        callback();
      },
    });

    this.#context['console'] = new Console({ stdout: sink, stderr: sink });
  }

  /** Split what was written into the lines an observation is made of. */
  #capture(text: string): void {
    const lines = text.split('\n');
    if (lines.at(-1) === '') {
      lines.pop();
    }
    for (const line of lines) {
      this.#logs.push(cut(line, MAX_LINE_CHARS));
    }
  }

  /**
   * `finish` is rebound for every turn.
   *
   * The binding captures the turn it belongs to, so a `finish()` that arrives
   * late (from a timer started in an earlier turn) cannot end the current
   * one. Within a turn the first `finish()` wins - it ends the turn, and
   * anything after it is ignored.
   */
  #installFinish(token: number): void {
    this.#context['finish'] = (answer: unknown): void => {
      if (token !== this.#execToken) {
        return;
      }
      if (this.#finalAnswer !== undefined) {
        return;
      }
      this.#finalAnswer =
        typeof answer === 'string' ? answer : (this.#render(answer) ?? String(answer));
    };
  }

  /**
   * The agent's model of the world, in the REPL.
   *
   * Facts and beliefs are kept apart on purpose: what was observed is not
   * what was concluded, and the agent has to be able to tell them apart
   * when it looks at its own model later.
   */
  #installWorld(): void {
    this.#context['world'] = {
      observe: (name: string, value: unknown, source: string): void => {
        this.#keep(addFact(this.#worldState, name, value, source, new Date().toISOString()));
      },
      believe: (name: string, value: unknown, confidence: number, source?: string): void => {
        this.#keep(
          addBelief(
            this.#worldState,
            name,
            value,
            confidence,
            source ?? 'concluded',
            new Date().toISOString(),
          ),
        );
      },
      state: (): WorldState => this.#worldState,
      report: (): string => formatWorld(this.#worldState),
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
    this.#context['step'] = async (
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
      this.#onStep?.(step);
      this.#keep(setPlan(this.#worldState, { name, description }));

      return await (body as StepBody)(name, description);
    };
  }

  #keep(state: WorldState): void {
    this.#worldState = state;
    this.#worldPort.write(state);
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
