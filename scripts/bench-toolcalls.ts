/**
 * Measures how often the model reaches for a tool that does not exist.
 *
 * A model trained with tool calling carries a format prior: "the user wants
 * a URL fetched" pulls towards a tool call, even when the request declares
 * no tools at all. This script counts how often that prior fires, so changes
 * to the system prompt can be measured instead of guessed.
 *
 *   ANTHROPIC_API_KEY=... ANTHROPIC_BASE_URL=... \
 *   npx tsx scripts/bench-toolcalls.ts [runs]
 */

import process from 'node:process';
import { Anthropic } from '@anthropic-ai/sdk';
import { AnthropicLlm } from '../src/adapters/anthropic/anthropic-llm.js';
import { NodeReplSession } from '../src/adapters/repl/node-repl.js';
import { runAgentTurn } from '../src/app/agent.js';
import { SYSTEM_PROMPT } from '../src/app/prompt.js';
import { Conversation } from '../src/domain/conversation.js';
import type { UiEvent, UiPort } from '../src/domain/ports/ui.js';

const TASKS = [
  '查一下 https://registry.npmjs.org/@anthropic-ai%2fclaude-code 这个包的最新版本号',
  '看看 https://api.github.com/repos/anthropics/claude-code/releases 最近发了哪几个版本',
  '用 https://www.amap.com/service/autoNavigat?usepoiquery=true&coor=116.459,39.909 查一下这个坐标',
];

interface RunResult {
  readonly steps: number;
  readonly toolCallTurns: number;
  readonly finished: boolean;
}

async function runOnce(llm: AnthropicLlm, task: string): Promise<RunResult> {
  let toolCallTurns = 0;

  const ui: UiPort = {
    emit: (event: UiEvent) => {
      const text = (event as { text?: string }).text ?? '';
      if (event.type === 'repl-error' && text.includes('tool call')) {
        toolCallTurns += 1;
      }
    },
    onInput: () => {},
    run: () => Promise.resolve(),
    stop: () => {},
  };

  const result = await runAgentTurn(
    {
      llm,
      repl: new NodeReplSession(),
      ui,
      systemPrompt: SYSTEM_PROMPT,
      maxTokens: 4096,
      maxSteps: 12,
    },
    new Conversation(),
    task,
    new AbortController().signal,
  );

  return { steps: result.steps, toolCallTurns, finished: result.finished };
}

async function main(): Promise<void> {
  const runs = Number(process.argv[2] ?? '3');
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const baseURL = process.env['ANTHROPIC_BASE_URL'];
  const model = process.env['ANTHROPIC_MODEL'] ?? 'MiniMax-M3.1-Flash';

  if (apiKey === undefined) {
    process.stderr.write('ANTHROPIC_API_KEY is not set.\n');
    process.exitCode = 1;
    return;
  }

  const client = new Anthropic({
    apiKey,
    ...(baseURL !== undefined ? { baseURL } : {}),
  });
  const llm = new AnthropicLlm({ client, model });

  let steps = 0;
  let toolCallTurns = 0;
  let finished = 0;
  let total = 0;

  for (const task of TASKS) {
    for (let run = 0; run < runs; run += 1) {
      const result = await runOnce(llm, task);
      steps += result.steps;
      toolCallTurns += result.toolCallTurns;
      finished += result.finished ? 1 : 0;
      total += 1;
      process.stdout.write(
        `steps=${result.steps} toolCallTurns=${result.toolCallTurns} finished=${result.finished}\n`,
      );
    }
  }

  process.stdout.write(
    `\n${total} runs: avgSteps=${(steps / total).toFixed(1)} ` +
      `toolCallTurns=${toolCallTurns} finished=${finished}/${total}\n`,
  );
}

await main();
