import type { EvalCheck, EvalTask } from '../types.js';
import { functional, PACKAGE, preserved, publicTests, unit, write } from './helpers.js';

function record(n: number, price = `${n + 1}.23`): string {
  return `${JSON.stringify({ version: 1, id: `item-${n}`, price, tags: n % 2 ? ['odd'] : [] })}\n`;
}

const records: Record<string, string> = Object.fromEntries(
  Array.from({ length: 8 }, (_, n) => [
    `records/${String(n).padStart(2, '0')}.json`,
    record(n, n === 6 ? 'BROKEN' : `${n + 1}.23`),
  ]),
);
const repaired: Record<string, string> = { ...records, 'records/06.json': record(6) };
function converted(text: string): string {
  const input = JSON.parse(text) as { id: string; price: string; tags: string[] };
  return JSON.stringify({
    version: 2,
    id: input.id,
    priceCents: Number(input.price.replace('.', '')),
    tags: input.tags,
  });
}
const migrated = Object.fromEntries(
  Object.entries(repaired).map(([file, text]) => [file, converted(text)]),
);
const late = {
  'records/late.json': record(80, '0.01'),
  'records/02.json': JSON.stringify({
    version: 2,
    id: 'item-2',
    priceCents: 999999,
    tags: ['external-update'],
  }),
};
const afterLate = {
  ...migrated,
  ...late,
  'records/late.json': converted(late['records/late.json']),
};

const fixtures = {
  'package.json': PACKAGE,
  'README.md': `# Catalog migration operations\nImplement migrate(root,{dryRun=false}={}) and rollback(root,file) exported by src/index.mjs, plus bin/catalog.mjs.\nRoot contains direct .json records; do not scan .backup/ or other subdirectories. Sort filenames by JS string order.\nv1: {version:1,id:<nonempty string>,price:<nonnegative digits + dot + exactly 2 digits>,tags:<string[]>}.\nv2: {version:2,id:<nonempty string>,priceCents:<nonnegative integer>,tags:<string[]>}.\nConvert v1 to exactly {version:2,id,priceCents,tags}, using exact integer cents. Valid v2 is unchanged byte for byte.\nmigrate returns {converted:[filenames],unchanged:[filenames],errors:[{file,error:'invalid record'}]}.\nValidate every record before writing anything. If any invalid record exists, converted and unchanged are [], report all invalid records, leave every record and backup untouched.\nDry-run reports planned converted and unchanged lists but never writes records or creates backups.\nSuccessful migration backs up every converted file's original bytes to root/.backup/<filename> before replacing it. Never overwrite an existing backup, even on a later conversion.\nA repeat run is idempotent; do not rewrite valid v2 files. New v1 files may arrive later.\nrollback(root,file) restores the exact saved bytes for that filename, keeps its backup, and leaves other files untouched.\nOnly filenames matching /^[A-Za-z0-9_-]+\\.json$/ are allowed for rollback; reject other names with RangeError. Missing backup must throw before modifying the target.\nCLI: node bin/catalog.mjs plan|migrate <root>, printing the migrate result as JSON. Exit 1 if errors is nonempty, otherwise 0. plan uses dryRun.\nCLI rollback: node bin/catalog.mjs rollback <root> <filename>, printing {restored:<filename>}.\nPreserve package.json, README.md and test/ throughout all user requests. No external dependencies.\n`,
  'src/index.mjs': `export {migrate,rollback} from './migration.mjs';\n`,
  'src/migration.mjs': `export function migrate(){throw new Error('Not implemented');}export function rollback(){throw new Error('Not implemented');}\n`,
  'bin/catalog.mjs': `throw new Error('Not implemented');\n`,
  'test/legacy.test.mjs': `import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {migrate} from '../src/index.mjs';test('empty catalog',()=>{fs.mkdirSync('test-empty',{recursive:true});assert.deepEqual(migrate('test-empty'),{converted:[],unchanged:[],errors:[]});});\n`,
  ...records,
};

const implementation = `import fs from 'node:fs';import path from 'node:path';
function valid(row){if(!row||typeof row.id!=='string'||!row.id||!Array.isArray(row.tags)||!row.tags.every(x=>typeof x==='string'))return false;return row.version===1?typeof row.price==='string'&&/^\\d+\\.\\d{2}$/.test(row.price):row.version===2&&Number.isInteger(row.priceCents)&&row.priceCents>=0;}
export function migrate(root,{dryRun=false}={}){const files=fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isFile()&&e.name.endsWith('.json')).map(e=>e.name).sort();const errors=[],rows=[];for(const file of files){try{const text=fs.readFileSync(path.join(root,file),'utf8'),row=JSON.parse(text);if(!valid(row))throw Error();rows.push({file,text,row});}catch{errors.push({file,error:'invalid record'});}}
if(errors.length)return {converted:[],unchanged:[],errors};const converted=[],unchanged=[];for(const {file,text,row} of rows){if(row.version===2){unchanged.push(file);continue;}converted.push(file);if(dryRun)continue;const backup=path.join(root,'.backup',file);fs.mkdirSync(path.dirname(backup),{recursive:true});if(!fs.existsSync(backup))fs.writeFileSync(backup,text);const cents=Number(row.price.replace('.',''));fs.writeFileSync(path.join(root,file),JSON.stringify({version:2,id:row.id,priceCents:cents,tags:row.tags}));}return {converted,unchanged,errors:[]};}
export function rollback(root,file){if(!/^[A-Za-z0-9_-]+\\.json$/.test(file))throw new RangeError('Invalid filename');const bytes=fs.readFileSync(path.join(root,'.backup',file));fs.writeFileSync(path.join(root,file),bytes);}\n`;
const cli = `import {migrate,rollback} from '../src/index.mjs';const [command,root,file]=process.argv.slice(2);if(command==='rollback'){rollback(root,file);console.log(JSON.stringify({restored:file}));}else if(command==='plan'||command==='migrate'){const result=migrate(root,{dryRun:command==='plan'});console.log(JSON.stringify(result));if(result.errors.length)process.exitCode=1;}else throw new Error('Invalid command');\n`;

function state(id: string, expected: Record<string, string>, afterTurn?: number): EvalCheck {
  return functional(
    id,
    `import fs from 'node:fs';const expected=${JSON.stringify(expected)};for(const [file,text] of Object.entries(expected))assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),JSON.parse(text),file);`,
    afterTurn,
  );
}

function run(command: string, output: string, expectedStatus: number, file?: string): string {
  return unit(
    `const fs=require('node:fs');const r=require('node:child_process').spawnSync(process.execPath,['bin/catalog.mjs',${JSON.stringify(command)},'records',...${JSON.stringify(file ? [file] : [])}],{encoding:'utf8'});if(r.status!==${expectedStatus})throw Error(r.stderr);fs.mkdirSync('reports',{recursive:true});fs.writeFileSync(${JSON.stringify(output)},r.stdout);say('Operation verified');`,
  );
}

export const RECOVERY_MIGRATION: EvalTask = {
  id: 'long/holdout/recoverable-migration',
  suite: 'capability',
  partition: 'holdout',
  description:
    'Seven operational turns covering validation failure, repaired external input, migration, idempotency, new data, rollback, and replay.',
  fixtures,
  updates: [
    { beforeTurn: 2, files: { 'records/06.json': record(6) } },
    { beforeTurn: 4, files: late },
  ],
  turns: [
    'Implement the migration API and CLI described in README.md. Validate the current records with the plan command, save its JSON output to reports/plan.json, and report any invalid input. Leave all record bytes and backups untouched at this stage. Preserve the protected files throughout this conversation.',
    'Try the actual migrate command on records/ and save its JSON output to reports/blocked.json. If validation fails, report it and leave the source records unchanged; do not invent a corrected price or migrate only the valid subset.',
    'The owner has now corrected the invalid input on disk. Re-read records/, run the real migration, and save its JSON output to reports/migrated.json. Verify backups and converted records.',
    'Run the migration again, save reports/rerun.json, and verify that it is idempotent. Preserve all existing records and original backups byte for byte.',
    'An additional v1 record and an externally updated v2 record have now arrived. Re-read current data, migrate only what needs conversion, and save reports/incremental.json. Preserve the external v2 update and every original backup.',
    'Use the rollback command to restore only 03.json from its original backup. Save its JSON output to reports/rollback.json. Verify exact restored bytes, keep the backup, and preserve every other current record.',
    'Migrate the catalog again and save reports/final.json. Verify that the rolled-back file is converted again while its first backup survives, and that all earlier validation and CLI contracts still hold.',
  ],
  checks: [
    ...[0, 1].flatMap((afterTurn) =>
      Object.entries(records).map(
        ([file, content]): EvalCheck => ({
          id: `untouched:${file}@${afterTurn}`,
          type: 'file',
          path: file,
          content,
          afterTurn,
        }),
      ),
    ),
    state('plan-inputs-unchanged', records, 0),
    { id: 'plan-has-no-backups', type: 'absent', path: 'records/.backup/00.json', afterTurn: 0 },
    state('failure-does-not-partially-migrate', records, 1),
    { id: 'failure-has-no-backups', type: 'absent', path: 'records/.backup/00.json', afterTurn: 1 },
    {
      id: 'plan-reports-invalid',
      type: 'json',
      path: 'reports/plan.json',
      value: {
        converted: [],
        unchanged: [],
        errors: [{ file: '06.json', error: 'invalid record' }],
      },
      afterTurn: 0,
    },
    {
      id: 'failed-migration-report',
      type: 'json',
      path: 'reports/blocked.json',
      value: {
        converted: [],
        unchanged: [],
        errors: [{ file: '06.json', error: 'invalid record' }],
      },
      afterTurn: 1,
    },
    state('initial-conversion', migrated, 2),
    {
      id: 'initial-migration-report',
      type: 'json',
      path: 'reports/migrated.json',
      value: {
        converted: Array.from({ length: 8 }, (_, n) => `${String(n).padStart(2, '0')}.json`),
        unchanged: [],
        errors: [],
      },
      afterTurn: 2,
    },
    state('rerun-retains-data', migrated, 3),
    ...Object.keys(migrated).flatMap((file): EvalCheck[] => [
      { id: `idempotent-bytes:${file}`, type: 'unchanged', path: file, sinceTurn: 2, afterTurn: 3 },
      {
        id: `preserve-backup:${file}`,
        type: 'unchanged',
        path: file.replace('records/', 'records/.backup/'),
        sinceTurn: 2,
      },
    ]),
    {
      id: 'rerun-is-no-op',
      type: 'json',
      path: 'reports/rerun.json',
      value: {
        converted: [],
        unchanged: Array.from({ length: 8 }, (_, n) => `${String(n).padStart(2, '0')}.json`),
        errors: [],
      },
      afterTurn: 3,
    },
    state('incremental-preserves-current-v2', afterLate, 4),
    {
      id: 'incremental-migration-report',
      type: 'json',
      path: 'reports/incremental.json',
      value: {
        converted: ['late.json'],
        unchanged: Array.from({ length: 8 }, (_, n) => `${String(n).padStart(2, '0')}.json`),
        errors: [],
      },
      afterTurn: 4,
    },
    state(
      'rollback-affects-one-file',
      { ...afterLate, 'records/03.json': repaired['records/03.json'] as string },
      5,
    ),
    {
      id: 'rollback-exact-bytes',
      type: 'file',
      path: 'records/03.json',
      content: repaired['records/03.json'] as string,
      afterTurn: 5,
    },
    state('final-catalog', afterLate),
    {
      id: 'rollback-report',
      type: 'json',
      path: 'reports/rollback.json',
      value: { restored: '03.json' },
      afterTurn: 5,
    },
    {
      id: 'final-migration-report',
      type: 'json',
      path: 'reports/final.json',
      value: {
        converted: ['03.json'],
        unchanged: [
          '00.json',
          '01.json',
          '02.json',
          '04.json',
          '05.json',
          '06.json',
          '07.json',
          'late.json',
        ],
        errors: [],
      },
    },
    functional(
      'first-backups-survive',
      `import fs from 'node:fs';const expected=${JSON.stringify({ ...repaired, 'records/late.json': late['records/late.json'] })};for(const [file,text] of Object.entries(expected))assert.equal(fs.readFileSync(file.replace('records/','records/.backup/'),'utf8'),text,file);`,
    ),
    functional(
      'general-api-and-dry-run',
      `
import fs from 'node:fs';import {migrate,rollback} from './src/index.mjs';fs.mkdirSync('cases',{recursive:true});const text='{"version":1,"id":"zero","price":"0.00","tags":[]}\\n';fs.writeFileSync('cases/a.json',text);assert.deepEqual(migrate('cases',{dryRun:true}),{converted:['a.json'],unchanged:[],errors:[]});assert.equal(fs.readFileSync('cases/a.json','utf8'),text);assert.ok(!fs.existsSync('cases/.backup'));migrate('cases');assert.equal(JSON.parse(fs.readFileSync('cases/a.json','utf8')).priceCents,0);rollback('cases','a.json');assert.equal(fs.readFileSync('cases/a.json','utf8'),text);assert.throws(()=>rollback('cases','../a.json'),RangeError);assert.throws(()=>rollback('cases','missing.json'));assert.equal(fs.readFileSync('cases/a.json','utf8'),text);
`,
    ),
    publicTests(),
    ...preserved(fixtures, ['package.json', 'README.md', 'test/legacy.test.mjs']),
  ],
  reference: [
    write({ 'src/migration.mjs': implementation, 'bin/catalog.mjs': cli }).replace(
      'say("Done");',
      'deposit("Migration implemented");',
    ),
    run('plan', 'reports/plan.json', 1),
    run('migrate', 'reports/blocked.json', 1),
    run('migrate', 'reports/migrated.json', 0),
    run('migrate', 'reports/rerun.json', 0),
    run('migrate', 'reports/incremental.json', 0),
    run('rollback', 'reports/rollback.json', 0, '03.json'),
    run('migrate', 'reports/final.json', 0),
  ],
};
