import process from 'node:process';
import { Anthropic } from '@anthropic-ai/sdk';
import { AnthropicLlm } from '../adapters/anthropic/anthropic-llm.js';
import { NodeReplSession } from '../adapters/repl/node-repl.js';
import { PiTuiUi } from '../adapters/tui/pi-tui-ui.js';
import { runAgentTurn } from '../app/agent.js';
import { SYSTEM_PROMPT } from '../app/prompt.js';
import { Conversation } from '../domain/conversation.js';
import { HELP, parseArgs } from './args.js';

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

  const ui = new PiTuiUi({ model: options.model, endpoint: endpointLabel(client.baseURL) });
  const llm = new AnthropicLlm({
    client,
    model: options.model,
  });
  const repl = new NodeReplSession();
  const conversation = new Conversation();
  const controller = new AbortController();

  const queue: string[] = [];
  let running = false;

  const drain = async (): Promise<void> => {
    try {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) {
          break;
        }
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
          next,
          controller.signal,
        );
      }
    } catch (error) {
      ui.emit({ type: 'repl-error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
  };

  ui.onInput((text: string) => {
    queue.push(text);
    if (running) {
      return;
    }
    running = true;
    void drain();
  });

  process.on('SIGINT', () => {
    controller.abort();
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
