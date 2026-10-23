import { createHash } from 'node:crypto';
import process from 'node:process';
import { Anthropic } from '@anthropic-ai/sdk';
import { AnthropicLlm } from '../adapters/anthropic/anthropic-llm.js';
import { JsBeautifyFormatter } from '../adapters/format/js-beautify.js';
import { JsHighlighter } from '../adapters/format/js-highlight.js';
import { NodeReplSession } from '../adapters/repl/node-repl.js';
import { JsonlSessionStore, replagentHome } from '../adapters/session/jsonl-sessions.js';
import { PiTuiUi } from '../adapters/tui/pi-tui-ui.js';
import { FileWorld } from '../adapters/world/file-world.js';
import { runAgentTurn } from '../app/agent.js';
import { SYSTEM_PROMPT } from '../app/prompt.js';
import { replaySession } from '../app/replay-session.js';
import { Conversation } from '../domain/conversation.js';
import type { LoadedSession, SessionSummary, SessionWriter } from '../domain/ports/session.js';
import type { UiPort } from '../domain/ports/ui.js';
import { INTERRUPTED_NOTE, isInterrupted, restoreConversation } from '../domain/session.js';
import { type CliOptions, HELP, parseArgs } from './args.js';
import { contextWindowFor } from './context-window.js';
import { TurnQueue } from './turn-queue.js';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const store = createStore(options);
  if (options.listSessions) {
    listSessions(store);
    return;
  }
  if (store === undefined && (options.resume !== undefined || options.continueLatest)) {
    // Resuming without recording would silently start a fresh session
    // instead, which is the opposite of what the flag asked for.
    process.stderr.write('--resume and --continue need sessions enabled.\n');
    process.exitCode = 1;
    return;
  }

  const client = createClient(options.baseUrl);
  if (client === undefined) {
    return;
  }

  let currentController: AbortController | undefined;
  const promptHash = hashPrompt(SYSTEM_PROMPT);
  const session = startSession(store, options, promptHash);
  const contextWindow = contextWindowFor(options.model, options.contextWindow);
  const ui = createUi(options, contextWindow, session.writer, () => {
    currentController?.abort();
  });

  applyResume(ui, session, options.model, promptHash);

  const llm = new AnthropicLlm({
    client,
    model: options.model,
    effort: options.effort,
  });
  const repl = new NodeReplSession({ world: new FileWorld(options.world) });

  const queue = new TurnQueue(
    async (text: string) => {
      const controller = new AbortController();
      currentController = controller;
      try {
        await runAgentTurn(
          {
            llm,
            repl,
            ui,
            systemPrompt: SYSTEM_PROMPT,
            maxTokens: options.maxTokens,
            maxSteps: options.maxSteps,
            ...(session.writer !== undefined ? { session: session.writer } : {}),
          },
          session.conversation,
          text,
          controller.signal,
        );
      } finally {
        currentController = undefined;
      }
    },
    (error: unknown) => {
      ui.emit({ type: 'repl-error', text: error instanceof Error ? error.message : String(error) });
    },
  );

  ui.onInput((text: string) => {
    queue.push(text);
  });

  process.on('SIGINT', () => {
    // The terminal is in raw mode, so ctrl+c arrives as a key press and never
    // as SIGINT. This is the escape hatch for the moments when the TUI is not
    // in charge of the terminal.
    ui.stop();
  });

  try {
    await ui.run();
  } finally {
    repl.close();
    session.writer?.close();
  }
}

/** The session store, unless the run is not supposed to be recorded. */
function createStore(options: CliOptions): JsonlSessionStore | undefined {
  return options.noSession
    ? undefined
    : new JsonlSessionStore({ home: replagentHome(), cwd: process.cwd() });
}

function listSessions(store: JsonlSessionStore | undefined): void {
  if (store === undefined) {
    process.stderr.write('--list-sessions needs sessions enabled.\n');
    process.exitCode = 1;
    return;
  }
  printSessions(store.list());
}

function createClient(baseUrl: string): Anthropic | undefined {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const authToken = process.env['ANTHROPIC_AUTH_TOKEN'];
  const hasApiKey = apiKey !== undefined && apiKey.trim().length > 0;
  const hasAuthToken = authToken !== undefined && authToken.trim().length > 0;

  if (!hasApiKey && !hasAuthToken) {
    process.stderr.write('Neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set.\n');
    process.exitCode = 1;
    return undefined;
  }

  return new Anthropic({
    ...(hasApiKey ? { apiKey } : {}),
    ...(hasAuthToken ? { authToken } : {}),
    ...(baseUrl.length > 0 ? { baseURL: baseUrl } : {}),
  });
}

interface StartedSession {
  readonly writer: SessionWriter | undefined;
  readonly conversation: Conversation;
  /** The file this run resumed, when it resumed one. */
  readonly resumed: LoadedSession | undefined;
}

/** Open the session the flags name, or start a new one. */
function startSession(
  store: JsonlSessionStore | undefined,
  options: CliOptions,
  promptHash: string,
): StartedSession {
  const resumeId = options.resume ?? (options.continueLatest ? store?.list()[0]?.id : undefined);
  const resumed = store !== undefined && resumeId !== undefined ? store.open(resumeId) : undefined;
  if (resumed !== undefined) {
    return {
      writer: resumed.writer,
      conversation: restoreConversation(resumed.events, resumed.header.model === options.model),
      resumed,
    };
  }
  return {
    writer: store?.create({
      model: options.model,
      effort: options.effort,
      maxTokens: options.maxTokens,
      maxSteps: options.maxSteps,
      world: options.world,
      systemPromptHash: promptHash,
      agent: 'replagent',
    }),
    conversation: new Conversation(),
    resumed: undefined,
  };
}

/**
 * Put a resumed session back on the screen, and say what changed since it was
 * recorded: a different model, a moved system prompt, a turn that never ended.
 */
function applyResume(ui: UiPort, session: StartedSession, model: string, promptHash: string): void {
  const resumed = session.resumed;
  if (resumed === undefined) {
    return;
  }
  replaySession(resumed.events, ui);
  if (resumed.header.model !== model) {
    note(
      ui,
      session.writer,
      `This session was recorded with ${resumed.header.model}; its reasoning is shown but not replayed to ${model}.`,
    );
  }
  if (resumed.header.systemPromptHash !== promptHash) {
    note(
      ui,
      session.writer,
      'The system prompt changed since this session was recorded; the prompt cache will be cold.',
    );
  }
  if (!isInterrupted(resumed.events)) {
    return;
  }
  ui.emit({ type: 'status', text: 'The previous turn was interrupted; the model was told.' });
  session.conversation.append('user', INTERRUPTED_NOTE);
  session.writer?.append({
    type: 'message',
    message: { role: 'user', text: INTERRUPTED_NOTE },
    origin: 'resume',
  });
}

function createUi(
  options: CliOptions,
  contextWindow: number,
  writer: SessionWriter | undefined,
  onInterrupt: () => void,
): PiTuiUi {
  return new PiTuiUi({
    model: options.model,
    contextWindow,
    ...(writer !== undefined ? { sessionId: writer.id } : {}),
    formatter: new JsBeautifyFormatter(),
    highlighter: new JsHighlighter(),
    onInterrupt,
  });
}

/** A note is shown to the human and kept in the session, so a resume sees it. */
function note(ui: UiPort, writer: SessionWriter | undefined, text: string): void {
  ui.emit({ type: 'status', text });
  writer?.append({ type: 'note', text });
}

function hashPrompt(prompt: string): string {
  return `sha256:${createHash('sha256').update(prompt).digest('hex')}`;
}

/** The listing `--list-sessions` prints, most recently used first. */
function printSessions(summaries: readonly SessionSummary[]): void {
  if (summaries.length === 0) {
    process.stdout.write('No sessions for this directory yet.\n');
    return;
  }
  for (const summary of summaries) {
    const time = new Date(summary.startedAt).toTimeString().slice(0, 5);
    const turns = `${summary.turns} ${summary.turns === 1 ? 'turn' : 'turns'}`;
    const what = summary.title ?? summary.firstUserText ?? '(no message)';
    process.stdout.write(
      `${summary.id}  ${time}  ${summary.model.padEnd(20)}  ${turns.padEnd(8)}  ${what}\n`,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
