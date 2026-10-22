export interface CliOptions {
  readonly model: string;
  readonly baseUrl: string | undefined;
  readonly maxTokens: number;
  readonly maxSteps: number;
  /** Where the agent's model of the world is kept. */
  readonly world: string;
  readonly help: boolean;
}

export const DEFAULT_MODEL = 'claude-sonnet-4-5';
export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_MAX_STEPS = 24;

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
  --base-url <url>    API base URL (default: $ANTHROPIC_BASE_URL or api.anthropic.com)
  --max-tokens <n>    max tokens per reply (default: ${DEFAULT_MAX_TOKENS})
  --max-steps <n>     max REPL rounds per turn (default: ${DEFAULT_MAX_STEPS})
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
    baseUrl: flags.baseUrl ?? env['ANTHROPIC_BASE_URL'],
    maxTokens: flags.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxSteps: flags.maxSteps ?? DEFAULT_MAX_STEPS,
    world: flags.world ?? DEFAULT_WORLD_PATH,
    help: flags.help,
  };
}

interface Flags {
  model: string | undefined;
  baseUrl: string | undefined;
  maxTokens: number | undefined;
  maxSteps: number | undefined;
  world: string | undefined;
  help: boolean;
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {
    model: undefined,
    baseUrl: undefined,
    maxTokens: undefined,
    maxSteps: undefined,
    world: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
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
      case '--max-tokens':
        flags.maxTokens = readNumber(argv, index, '--max-tokens');
        index += 1;
        break;
      case '--max-steps':
        flags.maxSteps = readNumber(argv, index, '--max-steps');
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

function readNumber(argv: readonly string[], index: number, flag: string): number {
  const raw = readValue(argv, index, flag);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} requires a positive integer, got "${raw}"`);
  }
  return value;
}
