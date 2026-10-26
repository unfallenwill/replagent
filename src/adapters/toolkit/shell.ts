import { spawn } from 'node:child_process';
import {
  BASH_MAX_OUTPUT,
  BASH_TIMEOUT,
  type BashOptions,
  type BashResult,
  requireIntent,
  type Toolkit,
  type ToolkitOptions,
} from './toolkit.js';

/**
 * Running a command.
 *
 * The command is spawned rather than run in-process, so a long build does
 * not freeze the screen: the human keeps typing, the agent keeps working,
 * and the command's output arrives when it is ready.
 */

/** Run a command and wait for it. */
export async function runCommand(
  options: ToolkitOptions,
  command: string,
  intent: unknown,
  runOptions?: BashOptions,
): Promise<BashResult> {
  const why = requireIntent('bash', intent);
  const timeout = runOptions?.timeout ?? BASH_TIMEOUT;

  const result = await spawnCommand(command, runOptions?.cwd ?? options.cwd, timeout);
  options.onAction({
    tool: `bash ${command}`,
    intent: why,
    detail: `${describeExit(result.code)} · ${countLines(result.stdout)} lines`,
  });

  return result;
}

/** The toolkit's way of running a command. */
export function bashTool(options: ToolkitOptions): Pick<Toolkit, 'bash'> {
  return {
    bash: (command, intent, runOptions) => runCommand(options, command, intent, runOptions),
  };
}

/** Spawn the command and collect what it says. */
function spawnCommand(command: string, cwd: string, timeout: number): Promise<BashResult> {
  return new Promise<BashResult>((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, timeout);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > BASH_MAX_OUTPUT) {
        stdout = stdout.slice(0, BASH_MAX_OUTPUT);
        killed = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > BASH_MAX_OUTPUT) {
        stderr = stderr.slice(0, BASH_MAX_OUTPUT);
      }
    });

    child.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(new Error(`bash could not run ${command}: ${error.message}`));
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (killed) {
        stderr += `\n… the command was stopped after ${timeout}ms`;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

/** How the command ended, in a word. */
function describeExit(code: number | null): string {
  if (code === null) {
    return 'stopped';
  }
  return `exit ${code}`;
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n').length;
}
