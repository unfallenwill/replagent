import { screenReport } from './experiments/analyze.js';
import { compatibilityIssues, readReport, STRICT_POLICY } from './report.js';

/** Freeze every task in an explicitly selected baseline, including explored capabilities. */
async function main(): Promise<void> {
  const [baselineFile, currentFile, ...extra] = process.argv.slice(2);
  if (baselineFile === undefined || currentFile === undefined || extra.length > 0)
    throw new Error('Usage: npm run eval:verify -- <baseline/report.json> <current/report.json>');
  const [baseline, current] = await Promise.all([
    readReport(baselineFile),
    readReport(currentFile),
  ]);
  const incompatible = compatibilityIssues(baseline, current, STRICT_POLICY);
  const regressions = screenReport(baseline, current);
  if (regressions.length === 0) {
    process.stdout.write('All baseline task/check rates preserved, including capability tasks.\n');
    return;
  }
  for (const failure of regressions) process.stderr.write(`${failure}\n`);
  process.exitCode = incompatible.length > 0 ? 2 : 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
