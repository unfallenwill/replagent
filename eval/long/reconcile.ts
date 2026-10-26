import { hash } from '../files.js';
import type { EvalTask } from '../types.js';
import { functional, PACKAGE, preserved, unit, write } from './helpers.js';

interface Order {
  id: string;
  version: number;
  customer: string;
  totalCents: number;
  status: 'paid' | 'cancelled';
}

function makeInputs(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let shard = 0; shard < 96; shard++) {
    const rows: unknown[] = [];
    for (let row = 0; row < 8; row++) {
      const n = shard * 8 + row;
      rows.push({
        id: `o${String(n % 131).padStart(3, '0')}`,
        version: Math.floor(n / 131) + 1,
        customer: `c${n % 13}`,
        totalCents: (n * 37) % 10007,
        status: n % 11 === 0 ? 'cancelled' : 'paid',
      });
      if (n % 29 === 0) rows.push({ id: `invalid-${n}`, version: 0 });
    }
    files[`input/${shard % 2 ? 'east' : 'west'}/part-${String(shard).padStart(3, '0')}.json`] =
      JSON.stringify(rows);
  }
  return files;
}

const initial = makeInputs();
const updates = {
  'input/east/part-007.json': JSON.stringify([
    { id: 'o007', version: 99, customer: 'late', totalCents: 7, status: 'paid' },
    { id: 'o099', version: 99, customer: 'late', totalCents: 3, status: 'cancelled' },
  ]),
  'input/new/late.json': JSON.stringify([
    { id: 'new-order', version: 1, customer: '新增客户', totalCents: 0, status: 'paid' },
    { id: 'o001', version: 99, customer: '__proto__', totalCents: 123, status: 'paid' },
    { id: '', version: 2, customer: 'x', totalCents: 5, status: 'paid' },
  ]),
};

function oracle(files: Record<string, string>): string {
  const winners = new Map<string, Order>();
  const rejected: { file: string; index: number }[] = [];
  for (const file of Object.keys(files).sort()) {
    const rows = JSON.parse(files[file] as string) as Order[];
    for (const [index, row] of rows.entries()) {
      if (!valid(row)) {
        rejected.push({ file: file.slice('input/'.length), index });
        continue;
      }
      if (row.version > (winners.get(row.id)?.version ?? 0)) winners.set(row.id, row);
    }
  }
  const orders = [...winners.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sums = new Map<string, { customer: string; count: number; totalCents: number }>();
  for (const order of orders.filter((row) => row.status === 'paid')) {
    const total = sums.get(order.customer) ?? { customer: order.customer, count: 0, totalCents: 0 };
    total.count++;
    total.totalCents += order.totalCents;
    sums.set(order.customer, total);
  }
  const totals = [...sums.values()].sort((a, b) =>
    a.customer < b.customer ? -1 : a.customer > b.customer ? 1 : 0,
  );
  return hash(JSON.stringify({ orders, totals, rejected }));
}

function valid(row: Order): boolean {
  return (
    typeof row.id === 'string' &&
    row.id.length > 0 &&
    typeof row.customer === 'string' &&
    row.customer.length > 0 &&
    Number.isInteger(row.version) &&
    row.version > 0 &&
    Number.isInteger(row.totalCents) &&
    row.totalCents >= 0 &&
    ['paid', 'cancelled'].includes(row.status)
  );
}

const implementation = `import fs from 'node:fs';import path from 'node:path';
export function reconcile(root){const files=[];function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())walk(p);else if(entry.isFile()&&entry.name.endsWith('.json'))files.push(path.relative(root,p).split(path.sep).join('/'));}}walk(root);files.sort();const winners=new Map(),rejected=[];
for(const file of files){const rows=JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));for(const [index,row] of rows.entries()){
if(!row||typeof row.id!=='string'||!row.id||typeof row.customer!=='string'||!row.customer||!Number.isInteger(row.version)||row.version<=0||!Number.isInteger(row.totalCents)||row.totalCents<0||!['paid','cancelled'].includes(row.status)){rejected.push({file,index});continue;}
if(row.version>(winners.get(row.id)?.version??0))winners.set(row.id,{id:row.id,version:row.version,customer:row.customer,totalCents:row.totalCents,status:row.status});}}
const orders=[...winners.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),map=new Map();for(const row of orders){if(row.status!=='paid')continue;const total=map.get(row.customer)??{customer:row.customer,count:0,totalCents:0};total.count++;total.totalCents+=row.totalCents;map.set(row.customer,total);}const totals=[...map.values()].sort((a,b)=>a.customer<b.customer?-1:a.customer>b.customer?1:0);return {orders,totals,rejected};}\n`;
const cli = `import fs from 'node:fs';import path from 'node:path';import {reconcile} from '../src/reconcile.mjs';const result=reconcile(process.argv[2]);fs.mkdirSync(path.dirname(process.argv[3]),{recursive:true});fs.writeFileSync(process.argv[3],JSON.stringify(result));\n`;
const fixtures = {
  'package.json': PACKAGE,
  'README.md': `# Order snapshot reconciliation\nImplement src/reconcile.mjs exporting reconcile(inputDirectory) and bin/reconcile.mjs.\nCLI: node bin/reconcile.mjs <input-directory> <output-json>. No external dependencies.\nRead every .json file recursively. Each contains an array of order snapshots. Ignore other extensions.\nValid snapshots have nonempty string id and customer, positive integer version, nonnegative integer totalCents, status paid or cancelled.\nDo not trim or normalize identifiers. Reject all other records.\nFor each id keep the highest version. Equal versions: first by lexicographically sorted relative POSIX file path, then array index.\nOutput exactly {orders,totals,rejected}. orders are latest snapshots with exactly id,version,customer,totalCents,status, sorted by id using JS string order.\nOnly paid winners contribute to totals [{customer,count,totalCents}], sorted by customer using JS string order.\nrejected is [{file,index}], where file is relative POSIX path within input-directory and index is zero-based. Sort by file, then index.\nCreate output parent directories. Inputs and package.json are read-only. The tool must work on a different input directory and on repeated runs.\n`,
  'src/reconcile.mjs': `export function reconcile(){throw new Error('Not implemented');}\n`,
  'bin/reconcile.mjs': `throw new Error('Not implemented');\n`,
  'input/ignore.txt': 'This is not a JSON shard. Do not parse it.\n',
  ...initial,
};

function reportCheck(file: string, expected: string, afterTurn?: number) {
  return functional(
    `report:${file}@${afterTurn ?? 'final'}`,
    `
import fs from 'node:fs';import {createHash} from 'node:crypto';
const r=JSON.parse(fs.readFileSync(${JSON.stringify(file)},'utf8'));
const normalized={orders:r.orders.map(({id,version,customer,totalCents,status})=>({id,version,customer,totalCents,status})),totals:r.totals.map(({customer,count,totalCents})=>({customer,count,totalCents})),rejected:r.rejected.map(({file,index})=>({file,index}))};
assert.deepEqual(Object.keys(r).sort(),['orders','rejected','totals']);assert.equal(createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),${JSON.stringify(expected)});
`,
    afterTurn,
  );
}

export const RECONCILIATION: EvalTask = {
  id: 'long/development/incremental-reconciliation',
  suite: 'capability',
  partition: 'development',
  description:
    'Build and rerun a deterministic reconciliation tool over 96 shards after externally published input changes.',
  fixtures,
  updates: [{ beforeTurn: 1, files: updates }],
  turns: [
    'Build the reconciliation tool described in README.md, process input/, and save reports/initial.json. Verify the results. Do not alter any inputs.',
    'New and replacement input shards have now been published in input/. Re-read current inputs and generate reports/current.json with your tool. Preserve reports/initial.json and every current input byte for byte.',
  ],
  checks: [
    reportCheck('reports/initial.json', oracle(initial), 0),
    reportCheck('reports/initial.json', oracle(initial)),
    reportCheck('reports/current.json', oracle({ ...initial, ...updates })),
    functional(
      'unseen-directory',
      `
import fs from 'node:fs';import {execFileSync} from 'node:child_process';import {reconcile} from './src/reconcile.mjs';
fs.mkdirSync('unseen/nested',{recursive:true});fs.writeFileSync('unseen/a.json',JSON.stringify([{id:'x',version:2,customer:'a',totalCents:11,status:'paid'},{id:'bad',version:0}]));fs.writeFileSync('unseen/nested/b.json',JSON.stringify([{id:'x',version:1,customer:'b',totalCents:99,status:'paid'},{id:'y',version:1,customer:'a',totalCents:0,status:'cancelled'}]));
const expected={orders:[{id:'x',version:2,customer:'a',totalCents:11,status:'paid'},{id:'y',version:1,customer:'a',totalCents:0,status:'cancelled'}],totals:[{customer:'a',count:1,totalCents:11}],rejected:[{file:'a.json',index:1}]};assert.deepEqual(await reconcile('unseen'),expected);execFileSync(process.execPath,['bin/reconcile.mjs','unseen','unseen-report.json']);assert.deepEqual(JSON.parse(fs.readFileSync('unseen-report.json','utf8')),expected);
`,
    ),
    ...preserved(fixtures, ['package.json', 'input/ignore.txt']),
    functional(
      'inputs-preserved',
      `
import fs from 'node:fs';import {createHash} from 'node:crypto';
const expected=${JSON.stringify(Object.fromEntries(Object.entries({ ...initial, ...updates }).map(([file, content]) => [file, hash(content)])))};
for(const [file,digest] of Object.entries(expected))assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'),digest,file);
`,
    ),
  ],
  reference: [
    write({ 'src/reconcile.mjs': implementation, 'bin/reconcile.mjs': cli }).replace(
      'say("Done");',
      'require("node:child_process").execFileSync(process.execPath,["bin/reconcile.mjs","input","reports/initial.json"]);say("Done");',
    ),
    unit(
      'require("node:child_process").execFileSync(process.execPath,["bin/reconcile.mjs","input","reports/current.json"]);say("Updated");',
    ),
  ],
};
