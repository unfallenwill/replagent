import { REASONING_EFFORTS, type ReasoningEffort } from '../domain/ports/llm.js';
import { DEFAULT_CONTEXT_WINDOW } from './context-window.js';

export interface CliOptions {
  readonly model: string;
  readonly baseUrl: string;
  readonly maxTokens: number;
  readonly maxSteps: number;
  /** How hard the model is asked to think, on the MiniMax ladder. */
  readonly effort: ReasoningEffort;
  /** The model's context window, when the human knows it and we do not. */
  readonly contextWindow: number | undefined;
  /** Where the agent's model of the world is kept. */
  readonly world: string;
  readonly help: boolean;
}

export const DEFAULT_MODEL = 'MiniMax-M3.1-Flash';
export const DEFAULT_BASE_URL = 'https://api.minimax.cn/anthropic';
export const DEFAULT_MAX_TOKENS = 131_072;
export const DEFAULT_MAX_STEPS = 24;
/** M3.1-Flash's own default: the most thinking the model will do. */
export const DEFAULT_EFFORT: ReasoningEffort = 'max';

/**
 * The world model lives in the project it is a model of, and next to the
 * work rather than in a hidden place somewhere else.
 */
export const DEFAULT_WORLD_PATH = '.replagent/world.json';

export const HELP: string = `replagent - an agent whose only language is javascript

Usage:
  replagent [options]

Options:
  --model <id>        model to use (default: $ANTHROPIC_MODEL or ${DEFAULT_MODEL})
  --base-url <url>    API base URL (default: $ANTHROPIC_BASE_URL or
                      ${DEFAULT_BASE_URL}; do not add /v1)
  --max-tokens <n>    max tokens per reply (default: ${DEFAULT_MAX_TOKENS};
                      thinking counts against it)
  --effort <level>    how hard the model thinks: ${REASONING_EFFORTS.join('|')}
                      (default: ${DEFAULT_EFFORT}, the M3.1-Flash default)
  --max-steps <n>     max REPL rounds per turn (default: ${DEFAULT_MAX_STEPS})
  --context-window <n>
                      the model's context window in tokens, for the usage
                      fraction in the status bar (default: ${DEFAULT_CONTEXT_WINDOW})
  --world <path>      where the agent keeps its model of the world
                      (default: ${DEFAULT_WORLD_PATH} in the working directory)
  -h, --help          show this help

Environment:
  ANTHROPIC_API_KEY     api key (x-api-key)
  ANTHROPIC_AUTH_TOKEN  bearer token (Authorization: Bearer) - for gateways
  ANTHROPIC_BASE_URL    api base url
  ANTHROPIC_MODEL       default model

In the app:
  /quit               leave
`;

/**
 * Argument parsing.
 *
 * Precedence is always: flag > environment > default. Unknown flags are an
 * error instead of being silently ignored.
 */
export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const flags = parseFlags(argv);

  return {
    model: flags.model ?? env['ANTHROPIC_MODEL'] ?? DEFAULT_MODEL,
    baseUrl: flags.baseUrl ?? env['ANTHROPIC_BASE_URL'] ?? DEFAULT_BASE_URL,
    maxTokens: flags.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxSteps: flags.maxSteps ?? DEFAULT_MAX_STEPS,
    effort: flags.effort ?? DEFAULT_EFFORT,
    contextWindow: flags.contextWindow,
    world: flags.world ?? DEFAULT_WORLD_PATH,
    help: flags.help,
  };
}

interface Flags {
  model: string | undefined;
  baseUrl: string | undefined;
  maxTokens: number | undefined;
  maxSteps: number | undefined;
  effort: ReasoningEffort | undefined;
  contextWindow: number | undefined;
  world: string | undefined;
  help: boolean;
}

/** The numeric flags, and the option each one fills in. */
const NUMBER_FLAGS: Readonly<Record<string, 'maxTokens' | 'maxSteps' | 'contextWindow'>> = {
  '--max-tokens': 'maxTokens',
  '--max-steps': 'maxSteps',
  '--context-window': 'contextWindow',
};

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {
    model: undefined,
    baseUrl: undefined,
    maxTokens: undefined,
    maxSteps: undefined,
    effort: undefined,
    contextWindow: undefined,
    world: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    const numberFlag = NUMBER_FLAGS[arg];
    if (numberFlag !== undefined) {
      flags[numberFlag] = readNumber(argv, index, arg);
      index += 1;
      continue;
    }
    switch (arg) {
      case '-h':
      case '--help':
        flags.help = true;
        break;
      case '--model':
        flags.model = readValue(argv, index, '--model');
        index += 1;
        break;
      case '--base-url':
        flags.baseUrl = readValue(argv, index, '--base-url');
        index += 1;
        break;
      case '--effort':
        flags.effort = readEffort(readValue(argv, index, '--effort'));
        index += 1;
        break;
      case '--world':
        flags.world = readValue(argv, index, '--world');
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return flags;
}

function readValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/**
 * The effort ladder the model accepts. `none` is not a cheaper rung here:
 * M3.1-Flash rejects it, so an unknown word is an error, not a fallback.
 */
function readEffort(raw: string): ReasoningEffort {
  const effort = REASONING_EFFORTS.find((candidate) => candidate === raw);
  if (effort === undefined) {
    throw new Error(`--effort must be one of ${REASONING_EFFORTS.join(', ')}, got "${raw}"`);
  }
  return effort;
}

function readNumber(argv: readonly string[], index: number, flag: string): number {
  const raw = readValue(argv, index, flag);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} requires a positive integer, got "${raw}"`);
  }
  return value;
}
