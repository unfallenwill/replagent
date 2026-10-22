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
  if (apiKey === undefined || apiKey.trim().length === 0) {
    process.stderr.write('ANTHROPIC_API_KEY is not set.\n');
    process.exitCode = 1;
    return;
  }

  const ui = new PiTuiUi({ model: options.model });
  const llm = new AnthropicLlm({
    client: new Anthropic({ apiKey }),
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
