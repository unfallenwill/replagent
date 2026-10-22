import { Console } from 'node:console';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import repl from 'node:repl';
import { PassThrough, Writable } from 'node:stream';
import type { Context } from 'node:vm';
import type { ReplObservation, ReplPort } from '../../domain/ports/repl.js';

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

export interface NodeReplOptions {
  /** Directory `require` resolves from. Defaults to the process cwd. */
  readonly cwd?: string;
  /** File name used in stack traces. */
  readonly filename?: string;
}

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
  #finalAnswer: string | undefined;
  #execToken = 0;
  #onUncaught: ((text: string) => void) | undefined;

  constructor(options: NodeReplOptions = {}) {
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

    this.#installConsole();
    this.#installRequire(options.cwd ?? process.cwd());
    this.#tapUncaught(output);
  }

  async exec(code: string): Promise<ReplObservation> {
    this.#execToken += 1;
    const token = this.#execToken;
    this.#logs.length = 0;
    this.#finalAnswer = undefined;
    this.#installFinish(token);

    const outcome = await this.#evaluate(code);
    const logs = [...this.#logs];

    if (outcome.kind !== 'ok') {
      return { ok: false, logs, value: undefined, error: outcome.message, finalAnswer: undefined };
    }

    return {
      ok: true,
      logs,
      value: this.#render(outcome.value),
      error: undefined,
      finalAnswer: this.#finalAnswer,
    };
  }

  /** Release the REPL's resources (readline interface, timers). */
  close(): void {
    this.#server.close();
  }

  #evaluate(code: string): Promise<EvalOutcome> {
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
    return this.#server.writer(value) ?? String(value);
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
      this.#logs.push(line);
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

  #installRequire(cwd: string): void {
    this.#context['require'] = createRequire(path.join(cwd, 'index.js'));
  }

  #tapUncaught(output: PassThrough): void {
    output.on('data', (chunk: unknown) => {
      const text = String(chunk);
      if (text.startsWith('Uncaught ')) {
        this.#onUncaught?.(text);
      }
    });
  }
}
