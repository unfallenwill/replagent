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
  /** The session to continue, by id or id prefix. */
  readonly resume: string | undefined;
  /** Continue the most recently used session for this directory. */
  readonly continueLatest: boolean;
  /** Print the session list and exit. */
  readonly listSessions: boolean;
  /** Run without recording the conversation. */
  readonly noSession: boolean;
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
  --resume <id>       continue a recorded session (id prefix is enough)
  --continue          continue the most recent session for this directory
  --list-sessions     list this directory's sessions and exit
  --no-session        do not record this session

Sessions are kept in ${'$'}REPLAGENT_HOME/projects/<cwd> (default: ~/.replagent).

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
    resume: flags.resume,
    continueLatest: flags.continueLatest,
    listSessions: flags.listSessions,
    noSession: flags.noSession,
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
  resume: string | undefined;
  continueLatest: boolean;
  listSessions: boolean;
  noSession: boolean;
  help: boolean;
}

/** The numeric flags, and the option each one fills in. */
const NUMBER_FLAGS: Readonly<Record<string, 'maxTokens' | 'maxSteps' | 'contextWindow'>> = {
  '--max-tokens': 'maxTokens',
  '--max-steps': 'maxSteps',
  '--context-window': 'contextWindow',
};

type BooleanFlag = 'help' | 'continueLatest' | 'listSessions' | 'noSession';

/** The flags that are a switch, and the option each one turns on. */
const BOOLEAN_FLAGS: Readonly<Record<string, BooleanFlag>> = {
  '-h': 'help',
  '--help': 'help',
  '--continue': 'continueLatest',
  '--list-sessions': 'listSessions',
  '--no-session': 'noSession',
};

type ValueFlag = 'model' | 'baseUrl' | 'world' | 'resume';

/** The flags that carry a string, and the option each one fills in. */
const VALUE_FLAGS: Readonly<Record<string, ValueFlag>> = {
  '--model': 'model',
  '--base-url': 'baseUrl',
  '--world': 'world',
  '--resume': 'resume',
};

function emptyFlags(): Flags {
  return {
    model: undefined,
    baseUrl: undefined,
    maxTokens: undefined,
    maxSteps: undefined,
    effort: undefined,
    contextWindow: undefined,
    world: undefined,
    resume: undefined,
    continueLatest: false,
    listSessions: false,
    noSession: false,
    help: false,
  };
}

function parseFlags(argv: readonly string[]): Flags {
  const flags = emptyFlags();
  let index = 0;
  while (index < argv.length) {
    index += parseFlag(argv, index, flags);
  }
  if (flags.resume !== undefined && flags.continueLatest) {
    throw new Error('--resume and --continue cannot be combined');
  }
  return flags;
}

/** Read the flag at `index`, and answer how many arguments it took. */
function parseFlag(argv: readonly string[], index: number, flags: Flags): number {
  const arg = argv[index];
  if (arg === undefined) {
    return 1;
  }

  const numberFlag = NUMBER_FLAGS[arg];
  if (numberFlag !== undefined) {
    flags[numberFlag] = readNumber(argv, index, arg);
    return 2;
  }

  const booleanFlag = BOOLEAN_FLAGS[arg];
  if (booleanFlag !== undefined) {
    flags[booleanFlag] = true;
    return 1;
  }

  const valueFlag = VALUE_FLAGS[arg];
  if (valueFlag !== undefined) {
    flags[valueFlag] = readValue(argv, index, arg);
    return 2;
  }

  if (arg === '--effort') {
    flags.effort = readEffort(readValue(argv, index, arg));
    return 2;
  }

  throw new Error(`Unknown argument: ${arg}`);
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
