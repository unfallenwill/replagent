import { hash } from '../files.js';
import { write } from '../long/helpers.js';
import type { EvalTask } from '../types.js';
import { READ_FIXTURES, repositoryChecks, trustedNode } from './helpers.js';
import { SNAPSHOT } from './snapshot.js';

const files = 'src/adapters/toolkit/files.ts';
const toolkit = 'src/adapters/toolkit/toolkit.ts';
const source = SNAPSHOT.fixtures[files];
const types = SNAPSHOT.fixtures[toolkit];
if (source === undefined || types === undefined) throw new Error('Missing repository source.');
const chosen = 'const chosen = from > 1 || to < lines.length ? sliceLines(lines, from, to) : text;';
if (!source.includes(chosen)) throw new Error('Pinned source changed.');

function task(
  id: string,
  description: string,
  request: string,
  check: string,
  patch: Readonly<Record<string, string>>,
): EvalTask {
  const lock = SNAPSHOT.fixtures['package-lock.json'];
  if (lock === undefined) throw new Error('Missing lockfile.');
  return {
    id: `repository/holdout/${id}`,
    suite: 'capability',
    partition: 'holdout',
    description,
    fixtures: SNAPSHOT.fixtures,
    setup: { type: 'node-project', lockHash: hash(lock) },
    turns: [
      `Work in this real replagent repository snapshot (${SNAPSHOT.commit}). Dependencies are already installed offline. ${request} Keep all original tests, root configuration, package.json, and lockfile byte-for-byte unchanged; add tests if helpful. Preserve the REPL design and existing public APIs. Verify the change.`,
    ],
    checks: [...repositoryChecks(), trustedNode('hidden-contract', check)],
    reference: [write(patch)],
  };
}

const tailSource = source.replace(
  chosen,
  `let chosen: string;
  if (readOptions?.tail !== undefined) {
    const n = readOptions.tail;
    if (!Number.isInteger(n) || n < 0) throw new RangeError('tail must be a nonnegative integer');
    if (readOptions.from !== undefined || readOptions.to !== undefined) throw new TypeError('tail cannot be combined with a range');
    chosen = n === 0 ? '' : lines.slice(-n).join('\\n');
  } else {
    chosen = from > 1 || to < lines.length ? sliceLines(lines, from, to) : text;
  }`,
);

const rangeSource = source.replace(
  '  const lines = splitLines(text);',
  `  for (const value of [readOptions?.from, readOptions?.to]) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new RangeError('line index must be a positive integer');
  }
  if (readOptions?.from !== undefined && readOptions.to !== undefined && readOptions.to < readOptions.from) throw new RangeError('reversed range');
  const lines = splitLines(text);`,
);

const selection = `import type { ReadOptions } from './toolkit.js';
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}
export function countLines(text: string): number { return splitLines(text).length; }
export function selectReadText(text: string, options?: ReadOptions): string {
  const lines = splitLines(text), from = options?.from ?? 1, to = options?.to ?? lines.length;
  if (!(from > 1 || to < lines.length)) return text;
  return lines.slice(Math.max(0,from-1),Math.min(lines.length,Math.max(from,to))).join('\\n');
}
`;
const refactored = source
  .replace(
    "import path from 'node:path';",
    "import path from 'node:path';\nimport { countLines, selectReadText } from './read-text.js';",
  )
  .replace(
    / {2}const lines = splitLines\(text\);[\s\S]*? {2}const chosen = [^\n]+;/,
    '  const chosen = selectReadText(text, readOptions);',
  )
  .replace(
    /\/\*\* The lines between two numbers, counting from one\. \*\/[\s\S]*?(?=function report\()/,
    '',
  );

const delegationProbe = `import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {readFile} from './src/adapters/toolkit/files.ts';let action;await fs.writeFile('probe.txt','real');assert.equal(await readFile({cwd:process.cwd(),onAction:a=>action=a},'probe.txt','delegate'),'delegated');assert.equal(action.detail,'17 lines');console.log('DELEGATED');`;

export const TASKS: readonly EvalTask[] = [
  task(
    'read-tail',
    'Add a typed optional toolkit feature in the full repository.',
    'Add optional ReadOptions.tail: number to read(path,intent,options). It returns the last N logical lines joined by LF without a final LF; splitting is on LF and the final empty piece after a trailing LF is not a line. Preserve CR characters within lines. Zero returns empty, N beyond the file returns all logical lines without the final LF, empty input returns empty. Reject non-integers, negative values, NaN and infinities with RangeError; reject combining tail with a defined from or to with TypeError. Without tail, preserve read behavior exactly. Keep action reporting and output truncation.',
    `${READ_FIXTURES}
      assert.equal(await read(opts,'sample.txt','tail',{tail:2}),'b\\nc');
      assert.equal(await read(opts,'sample.txt','all',{tail:99}),'a\\nb\\nc');
      assert.equal(await read(opts,'sample.txt','zero',{tail:0}),'');
      assert.equal(await read(opts,'empty.txt','empty',{tail:3}),'');
      for(const n of [-1,0.5,NaN,Infinity,-Infinity])await assert.rejects(()=>read(opts,'empty.txt','invalid',{tail:n}),RangeError);
      for(const option of [{tail:1,from:1},{tail:1,to:2}])await assert.rejects(()=>read(opts,'sample.txt','conflict',option),TypeError);
      await fs.writeFile('crlf.txt','甲\\r\\n乙\\r\\n');assert.equal(await read(opts,'crlf.txt','crlf',{tail:1}),'乙\\r');
      assert.equal(await read(opts,'sample.txt','default'),'a\\nb\\nc\\n');assert.equal(await read(opts,'sample.txt','range',{from:2,to:2}),'b');
      assert.ok(events.some(e=>e.tool==='read sample.txt'&&e.detail==='2 lines'));
    `,
    {
      [files]: tailSource,
      [toolkit]: types.replace(
        'export interface ReadOptions {',
        'export interface ReadOptions {\n  readonly tail?: number;',
      ),
    },
  ),
  task(
    'read-range-validation',
    'Fix silent acceptance of invalid line ranges in the full repository.',
    'Fix read line-range validation: any defined from/to must be a finite positive integer, otherwise reject with RangeError, even for an empty file. If both are defined and to < from, reject with RangeError. Keep valid old range semantics, default full-file byte content, action reporting, intent validation, and the output limit. Valid ranges past EOF return empty; a to past EOF clips to EOF.',
    `${READ_FIXTURES}
      for(const key of ['from','to'])for(const n of [0,-1,1.5,NaN,Infinity,-Infinity])await assert.rejects(()=>read(opts,'empty.txt','invalid',{[key]:n}),RangeError);
      await assert.rejects(()=>read(opts,'sample.txt','reversed',{from:3,to:2}),RangeError);
      assert.equal(await read(opts,'sample.txt','default'),'a\\nb\\nc\\n');assert.equal(await read(opts,'sample.txt','range',{from:2,to:2}),'b');
      assert.equal(await read(opts,'sample.txt','past EOF',{from:9}),'');assert.equal(await read(opts,'sample.txt','clip',{from:2,to:99}),'b\\nc');
      assert.equal(await read(opts,'empty.txt','empty',{from:1,to:3}),'');
    `,
    { [files]: rangeSource },
  ),
  task(
    'extract-read-text',
    'Refactor file selection behind a pure API with compatibility tests.',
    'Extract pure text selection into src/adapters/toolkit/read-text.ts exporting selectReadText(text:string, options?:ReadOptions):string and countLines(text:string):number. readFile in files.ts must delegate text selection and line counting to those exports. Preserve all existing behavior, including the current permissive range semantics (do not add validation in this refactor), empty/trailing-newline handling, CRLF bytes, intent/error behavior, action reporting, and truncation. Pure helpers must perform no filesystem I/O or reporting.',
    `import {selectReadText,countLines} from './src/adapters/toolkit/read-text.ts';
      for(const text of ['', 'a', 'a\\n','a\\nb\\nc\\n','a\\r\\nb\\r\\n','\\n\\n']) {
        const lines=text===''?[]:text.split('\\n');if(lines.length>1&&lines.at(-1)==='')lines.pop();
        assert.equal(countLines(text),lines.length);assert.equal(selectReadText(text),text);
        for(const option of [{from:2,to:2},{from:9},{to:1},{from:3,to:2},{from:0,to:2}]) {
          const from=option.from??1,to=option.to??lines.length;
          const expected=from>1||to<lines.length?lines.slice(Math.max(0,from-1),Math.min(lines.length,Math.max(from,to))).join('\\n'):text;
          assert.equal(selectReadText(text,option),expected);
        }
      }
      import fs from 'node:fs/promises';
      import path from 'node:path';import {pathToFileURL} from 'node:url';import {spawnSync} from 'node:child_process';
      const p='src/adapters/toolkit/read-text.ts', original=await fs.readFile(p,'utf8');
      try {
        await fs.writeFile(p,'export function selectReadText(){return "delegated";}export function countLines(){return 17;}');
        const r=spawnSync(process.execPath,['--import',pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href,'--input-type=module','--eval',${JSON.stringify(delegationProbe)}],{encoding:'utf8',timeout:6000});
        assert.equal(r.status,0,r.stderr);assert.ok(r.stdout.trim().endsWith('DELEGATED'));
      } finally {await fs.writeFile(p,original);}
    `,
    { [files]: refactored, 'src/adapters/toolkit/read-text.ts': selection },
  ),
];
