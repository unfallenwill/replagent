import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEvalArgs } from '../options.js';
import { analyzeMatrix } from './analyze.js';
import { experimentArms, runMatrix } from './matrix.js';
import { TASKS } from './tasks.js';

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const options = await parseEvalArgs(process.argv.slice(2), root);
  if (options.command !== 'run')
    throw new Error('Use run for the four-arm development experiment.');
  const reports = await runMatrix({
    config: options.config,
    root,
    tasks: TASKS,
    arms: experimentArms(root),
    onTrial: (arm, result) =>
      process.stdout.write(
        `${arm} ${result.passed ? 'PASS' : 'FAIL'} ${result.taskId} #${result.attempt} calls=${result.metrics.calls} ms=${result.metrics.wallMs}\n`,
      ),
  });
  for (const [index, report] of reports.entries()) {
    process.stdout.write(
      `${experimentArms(root)[index]?.id}: ${report.results.filter((r) => r.passed).length}/${report.results.length}\n`,
    );
  }
  await analyzeMatrix(options.config.out);
  process.stdout.write(`Reports: ${path.join(options.config.out, '<arm>/report.md')}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
