import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT } from '../../src/app/prompt.js';
import { EVOLVING_POLICY } from '../long/policy.js';
import { parseEvalArgs } from '../options.js';
import { confirmationStopReason, confirmationVerdict } from './confirmation.js';
import { runMatrix } from './matrix.js';

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const options = await parseEvalArgs(process.argv.slice(2), root);
  const plain = path.join(root, 'eval/candidate.ts');
  if (options.command !== 'run')
    throw new Error('Use run for independent repeatability confirmation.');
  if (options.config.candidate === plain && options.config.systemPrompt === SYSTEM_PROMPT)
    throw new Error(
      'Provide a different --candidate or --prompt-file before spending model tokens.',
    );
  const reports = await runMatrix({
    root,
    config: options.config,
    tasks: [EVOLVING_POLICY],
    purpose:
      'Independent repeated attempts. Require 10/10 in both arms, >=15% aggregate and median token reduction, and cheaper in >=9/10 pairs before the full regression gate. Stop if any attempt fails, accounting is missing, or two completed pairs have no savings; finish both arms of started pairs. This is not a held-out task.',
    arms: [
      { id: 'control', candidate: plain, systemPrompt: SYSTEM_PROMPT },
      {
        id: 'candidate',
        candidate: options.config.candidate,
        systemPrompt: options.config.systemPrompt,
      },
    ],
    stopWhen:
      options.config.mode === 'reference'
        ? undefined
        : (runs) =>
            confirmationStopReason(
              runs.find((run) => run.arm.id === 'control')?.results ?? [],
              runs.find((run) => run.arm.id === 'candidate')?.results ?? [],
            ),
    onTrial: (arm, r) =>
      process.stdout.write(
        `${arm} ${r.passed ? 'PASS' : 'FAIL'} #${r.attempt} calls=${r.metrics.calls}\n`,
      ),
  });
  const control = reports[0],
    candidate = reports[1];
  if (control === undefined || candidate === undefined)
    throw new Error('Missing confirmation reports.');
  const verdict = confirmationVerdict(control, candidate);
  await writeFile(
    path.join(options.config.out, 'confirmation.json'),
    JSON.stringify(verdict, null, 2),
  );
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  if (options.config.mode === 'live' && !verdict.readyForFullRegression) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
