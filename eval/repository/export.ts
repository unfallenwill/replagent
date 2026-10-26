import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hash } from '../files.js';

// Refresh only deliberately: task definitions and their content fingerprints change.
const root = fileURLToPath(new URL('../../', import.meta.url));
const commit = execFileSync('git', ['rev-parse', '33787c4^{commit}'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', commit], {
  cwd: root,
  encoding: 'utf8',
})
  .trim()
  .split('\n');
if (paths.some((file) => /(^|\/)\.env(?:\.|$)/.test(file)))
  throw new Error('Environment files must never enter evaluation fixtures.');
const fixtures = Object.fromEntries(
  paths.map((file) => [
    file,
    execFileSync('git', ['show', `${commit}:${file}`], { cwd: root, encoding: 'utf8' }),
  ]),
);
writeFileSync(
  new URL('./snapshot.json', import.meta.url),
  `${JSON.stringify({ commit, contentHash: hash(JSON.stringify(fixtures)), fixtures }, null, 2)}\n`,
);
