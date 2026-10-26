import type { EvalTask } from '../types.js';
import { functional, PACKAGE, preserved, publicTests, write } from './helpers.js';

const csv =
  '\uFEFFid,region,amount\r\na,"East, coast",0.10\r\nb,"West ""zone""",-0.20\r\na,Other,9.00\r\nc,East,not-money\r\nc,East,12.34\r\nd,"Multi\nline",1\r\ne,East,1.005\r\n';
const fixtures = {
  'package.json': PACKAGE,
  'README.md': `# Regional ledger importer\nRun node bin/import.mjs input.csv output.json. Public API: src/index.mjs.\nThe recent importer has quoting, integer money and duplicate-row defects. See docs/contract.md.\nDo not change package.json, fixtures/ or existing tests. No external packages.\n`,
  'docs/contract.md': `# Contract\nparseCsv(text) returns string[][], supports UTF-8 BOM, LF/CRLF, quoted commas/newlines and doubled quotes.\nAn empty text returns []; a terminal newline does not add an empty record. Empty fields are preserved.\nA quote may only open at field start; after its closing quote only comma, CRLF/LF or end is allowed.\nMalformed quotes throw SyntaxError. Treat bare CR as a line ending too.\nparseMoney(text) trims whitespace and returns exact integer cents from optional minus, digits and optional 1-2 decimal digits.\nReject other formats with RangeError. Negative and zero values are valid.\nimportCsv(text) requires exact header id,region,amount (after BOM). Wrong/missing header throws SyntaxError.\nReturn {rows:[{id,region,cents}],errors:[{record,reason}]}. Trim all cells.\nData records are numbered starting at 2, irrespective of physical embedded newlines.\nValidate in order: exactly 3 columns (reason columns), nonempty id (id), nonempty region (region), valid money (amount), duplicate valid id (duplicate).\nKeep the first valid occurrence; invalid rows must not reserve their id. Preserve record order.\naggregate(rows) returns [{region,count,cents}] sorted by JS string order of region, without mutating rows.\nCLI JSON is {accepted:rows.length,rejected:errors.length,totals:aggregate(rows),errors}.\nCLI must exit nonzero for a parse/header error and preserve any existing output byte for byte.\n`,
  'fixtures/ledger.csv': csv,
  'src/csv.mjs': `export function parseCsv(text){return text.trim().split(/\\r?\\n/).map(line=>line.split(','));}\n`,
  'src/money.mjs': `export function parseMoney(text){return Math.round(parseFloat(text)*100);}\n`,
  'src/importer.mjs': `import {parseCsv} from './csv.mjs';import {parseMoney} from './money.mjs';export function importCsv(text){return {rows:parseCsv(text).slice(1).map(([id,region,amount])=>({id,region,cents:parseMoney(amount)})),errors:[]};}\n`,
  'src/aggregate.mjs': `export function aggregate(rows){const totals={};for(const row of rows){totals[row.region]??={region:row.region,count:0,cents:0};totals[row.region].count++;totals[row.region].cents+=row.cents;}return Object.values(totals);}\n`,
  'src/index.mjs': `export {parseCsv} from './csv.mjs';export {parseMoney} from './money.mjs';export {importCsv} from './importer.mjs';export {aggregate} from './aggregate.mjs';\n`,
  'bin/import.mjs': `import fs from 'node:fs';import {importCsv,aggregate} from '../src/index.mjs';fs.writeFileSync(process.argv[3],'');const result=importCsv(fs.readFileSync(process.argv[2],'utf8'));fs.writeFileSync(process.argv[3],JSON.stringify({accepted:result.rows.length,rejected:result.errors.length,totals:aggregate(result.rows),errors:result.errors}));\n`,
  'test/legacy.test.mjs': `import {test} from 'node:test';import assert from 'node:assert/strict';import {parseCsv,parseMoney,importCsv} from '../src/index.mjs';test('simple rows',()=>{assert.deepEqual(parseCsv('a,b\\n1,2\\n'),[['a','b'],['1','2']]);assert.equal(parseMoney('1.23'),123);assert.equal(importCsv('id,region,amount\\nx,north,2.00\\n').rows[0].cents,200);});\n`,
};

const solution = {
  'src/csv.mjs': `export function parseCsv(text){
 text=text.replace(/^\\uFEFF/,'');if(!text)return [];const rows=[];let row=[],field='',quoted=false,closed=false;
 const push=()=>{row.push(field);field='';closed=false};
 for(let i=0;i<text.length;i++){const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++}else{quoted=false;closed=true}}else field+=c;continue;}
  if(c===','){push();continue;}
  if(c==='\\r'||c==='\\n'){push();rows.push(row);row=[];if(c==='\\r'&&text[i+1]==='\\n')i++;continue;}
  if(closed)throw new SyntaxError('Characters after quote');
  if(c==='"'){if(field!=='')throw new SyntaxError('Unexpected quote');quoted=true;}else field+=c;
 }
 if(quoted)throw new SyntaxError('Unclosed quote');if(field!==''||row.length||closed){push();rows.push(row);}return rows;
}\n`,
  'src/money.mjs': `export function parseMoney(text){const s=text.trim();if(!/^-?\\d+(?:\\.\\d{1,2})?$/.test(s))throw new RangeError('Invalid amount');const negative=s.startsWith('-');const [a,b='']=s.replace(/^-/,'').split('.');return (Number(a)*100+Number(b.padEnd(2,'0')))*(negative?-1:1);}\n`,
  'src/importer.mjs': `import {parseCsv} from './csv.mjs';import {parseMoney} from './money.mjs';
export function importCsv(text){const [header,...records]=parseCsv(text);if(JSON.stringify(header)!==JSON.stringify(['id','region','amount']))throw new SyntaxError('Invalid header');const rows=[],errors=[],seen=new Set();
for(let i=0;i<records.length;i++){const cells=records[i].map(x=>x.trim());let reason,cents;const [id,region,amount]=cells;
if(cells.length!==3)reason='columns';else if(!id)reason='id';else if(!region)reason='region';else {try{cents=parseMoney(amount)}catch{reason='amount'}if(!reason&&seen.has(id))reason='duplicate';}
if(reason)errors.push({record:i+2,reason});else{seen.add(id);rows.push({id,region,cents});}}return {rows,errors};}\n`,
  'src/aggregate.mjs': `export function aggregate(rows){const totals=new Map();for(const r of rows){if(!totals.has(r.region))totals.set(r.region,{region:r.region,count:0,cents:0});const t=totals.get(r.region);t.count++;t.cents+=r.cents;}return [...totals.values()].sort((a,b)=>a.region<b.region?-1:a.region>b.region?1:0);}\n`,
  'bin/import.mjs': fixtures['bin/import.mjs'].replace("fs.writeFileSync(process.argv[3],'');", ''),
};

export const CSV_PIPELINE: EvalTask = {
  id: 'long/development/csv-pipeline',
  suite: 'capability',
  partition: 'development',
  description:
    'Repair CSV parsing, exact money, row validation, aggregation, and non-destructive CLI failures together.',
  fixtures,
  turns: [
    'Repair the ledger importer end to end according to docs/contract.md. Reproduce the failures using fixtures/ledger.csv and cover the boundary cases. Keep the existing public API and protected files.',
  ],
  checks: [
    functional(
      'csv-and-money',
      `
import {parseCsv,parseMoney} from './src/index.mjs';
for(const ending of ['\\n','\\r\\n','\\r']){const text='a,b,c'+ending+'"x,y","say ""hi""","line'+ending+'two"'+ending;assert.deepEqual(parseCsv(text),[['a','b','c'],['x,y','say "hi"','line'+ending+'two']]);}
assert.deepEqual(parseCsv(''),[]);assert.deepEqual(parseCsv('a,,\\n'),[['a','','']]);assert.deepEqual(parseCsv('""'),[['']]);
for(const bad of ['"open','a"b,c','"closed"x,y'])assert.throws(()=>parseCsv(bad),SyntaxError);
for(let cents=-2000;cents<=2000;cents+=17){const text=(cents<0?'-':'')+Math.floor(Math.abs(cents)/100)+'.'+String(Math.abs(cents)%100).padStart(2,'0');assert.equal(parseMoney(' '+text+' '),cents);}
for(const bad of ['1.005','1e2','+2','NaN','','.2','2.'])assert.throws(()=>parseMoney(bad),RangeError);
`,
    ),
    functional(
      'pipeline-and-cli',
      `
import fs from 'node:fs';import {spawnSync} from 'node:child_process';import {importCsv,aggregate} from './src/index.mjs';
const result=importCsv(fs.readFileSync('fixtures/ledger.csv','utf8'));
assert.deepEqual(result,{rows:[{id:'a',region:'East, coast',cents:10},{id:'b',region:'West "zone"',cents:-20},{id:'c',region:'East',cents:1234},{id:'d',region:'Multi\\nline',cents:100}],errors:[{record:4,reason:'duplicate'},{record:5,reason:'amount'},{record:8,reason:'amount'}]});
const rows=[{region:'__proto__',cents:10},{region:'z',cents:-2},{region:'__proto__',cents:7}];const before=JSON.stringify(rows);assert.deepEqual(aggregate(rows),[{region:'__proto__',count:2,cents:17},{region:'z',count:1,cents:-2}]);assert.equal(JSON.stringify(rows),before);
const ok=spawnSync(process.execPath,['bin/import.mjs','fixtures/ledger.csv','out.json']);assert.equal(ok.status,0);const output=JSON.parse(fs.readFileSync('out.json','utf8'));assert.equal(output.accepted,4);assert.equal(output.rejected,3);assert.deepEqual(output.errors,result.errors);assert.deepEqual(output.totals,aggregate(result.rows));
fs.writeFileSync('broken.csv','id,region,amount\\na,"unterminated,2');fs.writeFileSync('keep.json','SENTINEL');const bad=spawnSync(process.execPath,['bin/import.mjs','broken.csv','keep.json']);assert.notEqual(bad.status,0);assert.equal(fs.readFileSync('keep.json','utf8'),'SENTINEL');
const invalid=importCsv('id,region,amount\\n,no,1\\nx,,1\\nx,no,nope\\nx,no,1\\nx,no,2\\ny,no,2,extra\\n');assert.deepEqual(invalid.errors.map(x=>x.reason),['id','region','amount','duplicate','columns']);
`,
    ),
    publicTests(),
    ...preserved(fixtures, ['package.json', 'fixtures/ledger.csv', 'test/legacy.test.mjs']),
  ],
  reference: [write(solution)],
};
