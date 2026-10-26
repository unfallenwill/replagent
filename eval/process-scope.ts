import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanEnvironment } from './graders.js';
import { stopProcess } from './process.js';

export interface ProcessScope {
  close(): Promise<void>;
}

/** Poll before execution starts, so timed-out intermediate shells remain identifiable. */
export async function createProcessScope(
  child: ChildProcess,
  trace: (event: object) => void,
): Promise<ProcessScope> {
  if (process.platform !== 'win32') return { close: () => stopProcess(child) };
  const watcher = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL('./process-watch.ps1', import.meta.url)),
      '-RootProcessId',
      String(child.pid),
    ],
    {
      windowsHide: true,
      env: cleanEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let partial = '',
    stderr = '',
    remaining: number | undefined;
  watcher.stdout.on('data', (chunk: Buffer) => {
    partial += chunk.toString();
    const lines = partial.split(/\r?\n/);
    partial = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line) as { type: string; remaining?: number; tracked?: number };
      trace({
        type: 'process.scope',
        phase: event.type,
        remaining: event.remaining,
        tracked: event.tracked,
        workerPid: child.pid,
      });
      if (event.type === 'ready') ready();
      if (event.type === 'closed') remaining = event.remaining;
    }
  });
  watcher.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(0, 4000);
  });
  const exited = new Promise<void>((resolve, reject) => {
    watcher.on('error', reject);
    watcher.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Process tracking failed (${code}): ${stderr}`)),
    );
  });
  // Attach rejection handling before startup, including failure before ready.
  void exited.catch(() => {});
  try {
    await deadline(
      Promise.race([
        started,
        exited.then(() => {
          throw new Error('Process tracker exited before ready.');
        }),
      ]),
      10_000,
    );
  } catch (error) {
    watcher.kill();
    await stopProcess(child);
    throw error;
  }
  return {
    async close() {
      watcher.stdin.end('stop\n');
      try {
        await deadline(exited, 15_000);
        if (remaining !== 0)
          throw new Error(`Process tracking left ${remaining ?? 'unknown'} descendants.`);
      } finally {
        watcher.kill();
        await stopProcess(child);
      }
    },
  };
}

async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Process tracker timed out.')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
