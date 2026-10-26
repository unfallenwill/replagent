import type { EvalTask } from '../types.js';
import { functional, PACKAGE, preserved, publicTests, write } from './helpers.js';

const fixtures = {
  'package.json': PACKAGE,
  'config/shipping.json':
    '{"fee":300,"freeAt":2000,"blockedRegions":["island","restricted"],"rushFee":700}\n',
  'README.md': `# Shipping quotes\nPublic module src/index.mjs, currently incomplete. quote(request,config) uses integer cents.\nRetain earlier requirements as this feature evolves. No external dependencies.\nDo not change config/, package.json or existing tests. All input objects are read-only.\n`,
  'src/index.mjs': `export function quote(request,config){return {status:'ok',subtotal:request.subtotal,discount:0,shipping:config.fee,total:request.subtotal+config.fee};}\n`,
  'test/base.test.mjs': `import {test} from 'node:test';import assert from 'node:assert/strict';import {quote} from '../src/index.mjs';test('ordinary small order',()=>{assert.deepEqual(quote({subtotal:1000},{fee:300,freeAt:2000,blockedRegions:[],rushFee:700}),{status:'ok',subtotal:1000,discount:0,shipping:300,total:1300});});\n`,
};

function implementation(stage: number): string {
  return `export function quote(request,config){
const {subtotal}=request;if(!Number.isInteger(subtotal)||subtotal<0)throw new RangeError('Invalid subtotal');
${stage >= 4 ? "if(request.coupon!=null&&request.coupon!=='LESS200')throw new RangeError('Unknown coupon');" : ''}
${stage >= 5 ? "if(request.service!==undefined&&!['standard','rush'].includes(request.service))throw new RangeError('Unknown service');" : ''}
let discount=${stage >= 1 ? "request.member==='gold'?Math.round(subtotal*.10):0" : '0'};
${stage >= 4 ? "if(request.coupon==='LESS200')discount=Math.min(subtotal,discount+200);" : ''}
const discounted=subtotal-discount,digital=${stage >= 3 ? 'request.digitalOnly===true' : 'false'};
${stage >= 2 ? "if(!digital&&config.blockedRegions.includes(request.region))return {status:'unavailable',subtotal,discount,shipping:null,total:null};" : ''}
let shipping=digital||discounted>=config.freeAt?0:config.fee;
${stage >= 5 ? "if(!digital&&request.service==='rush')shipping+=config.rushFee;" : ''}
return {status:'ok',subtotal,discount,shipping,total:discounted+shipping};}
${stage >= 6 ? "export function quoteBatch(requests,config){const quotes=requests.map(r=>quote(r,config));return {quotes,unavailableCount:quotes.filter(q=>q.status==='unavailable').length,grandTotal:quotes.reduce((s,q)=>s+(q.total??0),0)};}" : ''}\n`;
}

const cli = `import fs from 'node:fs';import {quoteBatch} from '../src/index.mjs';const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const config=JSON.parse(fs.readFileSync(new URL('../config/shipping.json',import.meta.url),'utf8'));fs.writeFileSync(process.argv[3],JSON.stringify(quoteBatch(input,config)));\n`;

function checks(stage: number, afterTurn?: number) {
  return functional(
    `policy-v${stage}-${afterTurn ?? 'final'}`,
    `
import {quote} from './src/index.mjs';
const stage=${stage};
for(const fee of [0,311])for(let n=0;n<45;n++){
 const config={fee,freeAt:2000,blockedRegions:['island','restricted'],rushFee:701};
 const request={subtotal:n*123,member:stage>=1&&n%2?'gold':'basic',region:stage>=2&&n%3===0?'island':'mainland',digitalOnly:stage>=3&&n%4===0,coupon:stage>=4&&n%5===0?'LESS200':undefined,service:stage>=5&&n%3===1?'rush':'standard'};
 const before=JSON.stringify({request,config});let discount=stage>=1&&request.member==='gold'?Math.round(request.subtotal*.1):0;
 if(stage>=4&&request.coupon==='LESS200')discount=Math.min(request.subtotal,discount+200);
 const digital=stage>=3&&request.digitalOnly;const blocked=stage>=2&&!digital&&config.blockedRegions.includes(request.region);
 let shipping=digital||request.subtotal-discount>=config.freeAt?0:fee;if(stage>=5&&!digital&&request.service==='rush')shipping+=config.rushFee;
 const expected={status:blocked?'unavailable':'ok',subtotal:request.subtotal,discount,shipping:blocked?null:shipping,total:blocked?null:request.subtotal-discount+shipping};
 assert.deepEqual(quote(request,config),expected,'n='+n+' stage='+stage);assert.equal(JSON.stringify({request,config}),before);
}
for(const subtotal of [-1,1.5,NaN])assert.throws(()=>quote({subtotal},{fee:1,freeAt:10,blockedRegions:[],rushFee:1}),RangeError);
if(stage>=4)assert.throws(()=>quote({subtotal:10,coupon:'bad'},{fee:1,freeAt:10,blockedRegions:[],rushFee:1}),RangeError);
if(stage>=5)assert.throws(()=>quote({subtotal:10,service:'bad'},{fee:1,freeAt:10,blockedRegions:[],rushFee:1}),RangeError);
`,
    afterTurn,
  );
}

export const EVOLVING_POLICY: EvalTask = {
  id: 'long/development/evolving-policy',
  suite: 'capability',
  partition: 'development',
  description:
    'Seven consecutive feature requests with independent snapshots of every accepted version and retained earlier constraints.',
  fixtures,
  turns: [
    'Implement quote(request,config) in src/index.mjs. request.subtotal must be a nonnegative integer, otherwise throw RangeError. Return exactly {status:"ok",subtotal,discount:0,shipping,total}; shipping is 0 when subtotal>=config.freeAt, otherwise config.fee; total=subtotal+shipping. Preserve package.json, config/ and all existing tests throughout this conversation. Never mutate request or config. Verify each change before replying.',
    'Add membership: member="gold" receives Math.round(subtotal*0.10) cents discount; everyone else gets 0. Shipping threshold now uses subtotal-discount, and total=subtotal-discount+shipping. Retain all earlier requirements.',
    'Add region restrictions: for a region listed in config.blockedRegions, return {status:"unavailable",subtotal,discount,shipping:null,total:null}. Other quotes stay as before. Keep membership and validation working.',
    'Support digitalOnly=true: digital orders have shipping=0 and may be fulfilled even in blocked regions. Physical orders retain all region and threshold rules. All other requirements remain.',
    'Add coupon LESS200: apply 200 additional cents after the membership discount, capped so total discount never exceeds subtotal. Undefined/null coupon means none; any other coupon throws RangeError. Shipping threshold uses subtotal minus both discounts. Keep all earlier behavior.',
    'Add service standard or rush; omitted means standard, any other value throws RangeError. Physical rush orders add config.rushFee to shipping even when the normal fee is waived by the threshold. Digital orders never pay shipping or rush fees. Region restrictions still apply. Preserve previous requirements.',
    'Add exported quoteBatch(requests,config) returning exactly {quotes,unavailableCount,grandTotal}. quotes preserves input order; unavailableCount counts unavailable quotes; grandTotal sums non-null totals. Also add node bin/quote.mjs input.json output.json, reading the JSON request array and config/shipping.json. Verify the CLI and all previous features. Preserve the protected files.',
  ],
  checks: [
    ...Array.from({ length: 7 }, (_, stage) => checks(stage, stage)),
    checks(6),
    functional(
      'batch-and-cli',
      `
import fs from 'node:fs';import {execFileSync} from 'node:child_process';import {quote,quoteBatch} from './src/index.mjs';
const config=JSON.parse(fs.readFileSync('config/shipping.json','utf8'));const input=[{subtotal:1000,member:'gold',coupon:'LESS200',service:'rush'},{subtotal:3000,region:'island'},{subtotal:5,member:'gold',coupon:'LESS200',digitalOnly:true,region:'restricted'}];
const expected={quotes:input.map(x=>quote(x,config)),unavailableCount:1,grandTotal:1700};assert.deepEqual(quoteBatch(input,config),expected);assert.deepEqual(quoteBatch([],config),{quotes:[],unavailableCount:0,grandTotal:0});
fs.writeFileSync('batch.json',JSON.stringify(input));execFileSync(process.execPath,['bin/quote.mjs','batch.json','batch-out.json']);assert.deepEqual(JSON.parse(fs.readFileSync('batch-out.json','utf8')),expected);
`,
    ),
    publicTests(),
    ...preserved(fixtures, ['package.json', 'config/shipping.json', 'test/base.test.mjs']),
  ],
  reference: Array.from({ length: 7 }, (_, stage) =>
    write({
      'src/index.mjs': implementation(stage),
      ...(stage === 6 ? { 'bin/quote.mjs': cli } : {}),
    }),
  ),
};
