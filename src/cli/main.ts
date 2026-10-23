import process from 'node:process';
import { Anthropic } from '@anthropic-ai/sdk';
import { AnthropicLlm } from '../adapters/anthropic/anthropic-llm.js';
import { JsBeautifyFormatter } from '../adapters/format/js-beautify.js';
import { JsHighlighter } from '../adapters/format/js-highlight.js';
import { NodeReplSession } from '../adapters/repl/node-repl.js';
import { PiTuiUi } from '../adapters/tui/pi-tui-ui.js';
import { FileWorld } from '../adapters/world/file-world.js';
import { runAgentTurn } from '../app/agent.js';
import { SYSTEM_PROMPT } from '../app/prompt.js';
import { Conversation } from '../domain/conversation.js';
import { HELP, parseArgs } from './args.js';
import { contextWindowFor } from './context-window.js';
import { TurnQueue } from './turn-queue.js';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const authToken = process.env['ANTHROPIC_AUTH_TOKEN'];
  const hasApiKey = apiKey !== undefined && apiKey.trim().length > 0;
  const hasAuthToken = authToken !== undefined && authToken.trim().length > 0;

  if (!hasApiKey && !hasAuthToken) {
    process.stderr.write('Neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set.\n');
    process.exitCode = 1;
    return;
  }

  const client = new Anthropic({
    ...(hasApiKey ? { apiKey } : {}),
    ...(hasAuthToken ? { authToken } : {}),
    ...(options.baseUrl !== undefined ? { baseURL: options.baseUrl } : {}),
  });

  let currentController: AbortController | undefined;

  const contextWindow = contextWindowFor(options.model, options.contextWindow);
  const ui = new PiTuiUi({
    model: options.model,
    endpoint: endpointLabel(client.baseURL),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    formatter: new JsBeautifyFormatter(),
    highlighter: new JsHighlighter(),
    onInterrupt: () => {
      currentController?.abort();
    },
  });
  const llm = new AnthropicLlm({
    client,
    model: options.model,
    effort: options.effort,
  });
  const repl = new NodeReplSession({ world: new FileWorld(options.world) });
  const conversation = new Conversation();

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
          },
          conversation,
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
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

/** Short label for the endpoint the agent talks to. */
function endpointLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
