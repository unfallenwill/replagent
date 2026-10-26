import { hash } from '../files.js';
import { preserved } from '../long/helpers.js';
import type { EvalCheck } from '../types.js';
import { SNAPSHOT } from './snapshot.js';

/** New tests cannot replace the pinned repository's old tests or their configuration. */
export function repositoryChecks(): EvalCheck[] {
  return [
    ...preserved(
      SNAPSHOT.fixtures,
      Object.keys(SNAPSHOT.fixtures).filter(
        (file) =>
          file.startsWith('test/') ||
          (!file.includes('/') && !['README.md', 'LICENSE'].includes(file)),
      ),
    ),
    trustedNode(
      'old-tests',
      `
      import {spawnSync} from 'node:child_process';
      import fs from 'node:fs';
      const resultFile='.eval-old-tests.json';fs.rmSync(resultFile,{force:true});
      const r=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--reporter=json','--outputFile',resultFile],{encoding:'utf8',timeout:100000});
      assert.equal(r.status,0,r.stdout+r.stderr);
      const result=JSON.parse(fs.readFileSync(resultFile,'utf8'));
      assert.equal(result.success,true);assert.equal(result.numFailedTests,0);assert.ok(result.numPassedTests>=268,'Original tests did not all run');
    `,
      120_000,
    ),
    trustedNode(
      'types',
      `
      import {spawnSync} from 'node:child_process';
      const r=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--noEmit'],{encoding:'utf8',timeout:30000});
      assert.equal(r.status,0,r.stdout+r.stderr);
    `,
      45_000,
    ),
  ];
}

/** The assertions execute in a child with a completion marker, using local pinned tsx. */
export function trustedNode(id: string, code: string, timeoutMs = 15_000): EvalCheck {
  const marker = `repository-assertions-${hash(code).slice(0, 16)}`;
  const test = `import assert from 'node:assert/strict';\n${code}\nconsole.log(${JSON.stringify(marker)});`;
  return {
    id,
    type: 'node',
    timeoutMs,
    code: `import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import path from 'node:path';import {pathToFileURL} from 'node:url';const r=spawnSync(process.execPath,['--import',pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href,'--input-type=module','--eval',${JSON.stringify(test)}],{encoding:'utf8',timeout:${timeoutMs - 2000},maxBuffer:4000000});assert.equal(r.status,0,r.stdout+r.stderr);assert.ok(r.stdout.trim().endsWith(${JSON.stringify(marker)}),'Assertions were bypassed');`,
  };
}

export const READ_FIXTURES: string = `
  import fs from 'node:fs/promises';
  import {readFile as read} from './src/adapters/toolkit/files.ts';
  const events=[];const opts={cwd:process.cwd(),onAction:e=>events.push(e)};
  await fs.writeFile('sample.txt','a\\nb\\nc\\n');await fs.writeFile('empty.txt','');
`;
