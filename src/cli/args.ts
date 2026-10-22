export interface CliOptions {
  readonly model: string;
  readonly maxTokens: number;
  readonly maxSteps: number;
  readonly help: boolean;
}

export const DEFAULT_MODEL: string = 'claude-sonnet-4-5';
export const DEFAULT_MAX_TOKENS: number = 8192;
export const DEFAULT_MAX_STEPS: number = 24;

export const HELP: string = `replagent - an agent whose only language is javascript

Usage:
  replagent [options]

Options:
  --model <id>        model to use (default: ${DEFAULT_MODEL})
  --max-tokens <n>    max tokens per reply (default: ${DEFAULT_MAX_TOKENS})
  --max-steps <n>     max REPL rounds per turn (default: ${DEFAULT_MAX_STEPS})
  -h, --help          show this help

Environment:
  ANTHROPIC_API_KEY   required

In the app:
  /quit               leave
`;

/**
 * Minimal, explicit argument parsing. Unknown flags are an error instead of
 * being silently ignored.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  let model = DEFAULT_MODEL;
  let maxTokens = DEFAULT_MAX_TOKENS;
  let maxSteps = DEFAULT_MAX_STEPS;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--model') {
      model = readValue(argv, index, '--model');
      index += 1;
      continue;
    }
    if (arg === '--max-tokens') {
      maxTokens = readNumber(argv, index, '--max-tokens');
      index += 1;
      continue;
    }
    if (arg === '--max-steps') {
      maxSteps = readNumber(argv, index, '--max-steps');
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { model, maxTokens, maxSteps, help };
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
